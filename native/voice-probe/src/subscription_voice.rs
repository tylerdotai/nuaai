//! Explicit subscription helper. Fixed service authority; no executor or refresh.
use codex_api::{
    ApiError, Provider, RealtimeCallClient, RealtimeContextAppendChannel, RealtimeEvent,
    RealtimeEventParser, RealtimeOutputModality, RealtimeSessionConfig, RealtimeSessionMode,
    RealtimeTranscriptState, RealtimeWebsocketClient, RealtimeWebsocketConnection, RetryConfig,
    SharedAuthProvider,
};
use codex_http_client::{
    ClientRouteClass, DestinationPolicy, HttpClientFactory, HttpTransport, NetworkPolicyController,
    OutboundProxyPolicy, Request, ReqwestTransport, Response, StreamResponse, TransportError,
};
use codex_login::{
    AuthCredentialsStoreMode, AuthKeyringBackendKind, AuthManager, AuthRouteConfig, CodexAuth,
};
use http::HeaderMap;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    path::PathBuf,
    pin::Pin,
    time::Duration,
};

// Reuse the frozen strict codec unchanged, not its inert Session/backend.
#[allow(dead_code)] // The frozen module also contains the independent memory backend.
#[path = "offline_helper.rs"]
mod wire;
use wire::{MAX_FRAME, command_id};

pub const PROFILE: &str = "subscription-webrtc-v3";
const BASE: &str = "https://chatgpt.com/backend-api/codex";
const CALL_ENDPOINT: &str =
    "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const MAX_TEXT: usize = 16_384;
const MAX_IDS: usize = 256;
const DEADLINE: Duration = Duration::from_secs(25);
const CLEANUP: Duration = Duration::from_secs(2);
type Result<T> = std::result::Result<T, Code>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Protocol,
    Payload,
    Provider,
    Login,
    Subscription,
    Access,
    Quota,
    Rate,
    Authority,
    Disconnected,
    Timeout,
    Cleanup,
}
impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Protocol => "VOICE_PROTOCOL_ERROR",
            Self::Payload => "VOICE_PAYLOAD_TOO_LARGE",
            Self::Provider => "VOICE_PROVIDER_ERROR",
            Self::Login => "VOICE_CODEX_LOGIN_REQUIRED",
            Self::Subscription => "VOICE_SUBSCRIPTION_REQUIRED",
            Self::Access => "VOICE_ACCESS_DENIED",
            Self::Quota => "VOICE_QUOTA_EXCEEDED",
            Self::Rate => "VOICE_RATE_LIMITED",
            Self::Authority => "VOICE_AUTHORITY_VIOLATION",
            Self::Disconnected => "VOICE_PROVIDER_DISCONNECTED",
            Self::Timeout => "VOICE_NEGOTIATION_TIMEOUT",
            Self::Cleanup => "VOICE_CLEANUP_FAILED",
        }
    }
}
fn api_error(error: ApiError) -> Code {
    match error {
        ApiError::Api { status, .. } => http_error(status, None),
        ApiError::Transport(TransportError::Http { status, body, .. }) => http_error(status, body),
        ApiError::Transport(TransportError::Timeout) => Code::Timeout,
        ApiError::QuotaExceeded | ApiError::UsageNotIncluded => Code::Quota,
        ApiError::RateLimitExceeded { .. } | ApiError::RateLimit(_) => Code::Rate,
        _ => Code::Provider,
    }
}
fn http_error(status: http::StatusCode, body: Option<String>) -> Code {
    // Inspect only a bounded structured service code, never stringify/export errors.
    let code = body
        .filter(|body| body.len() <= MAX_FRAME)
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .and_then(|body| body["error"]["code"].as_str().map(str::to_owned));
    if status == http::StatusCode::TOO_MANY_REQUESTS
        && matches!(
            code.as_deref(),
            Some("insufficient_quota" | "quota_exceeded")
        )
    {
        return Code::Quota;
    }
    match status.as_u16() {
        401 => Code::Login,
        402 => Code::Subscription,
        403 => Code::Access,
        429 => Code::Rate,
        _ => Code::Provider,
    }
}
fn codec_error(error: wire::Error) -> Code {
    match error {
        wire::Error::Protocol => Code::Protocol,
        wire::Error::Payload => Code::Payload,
        wire::Error::Io => Code::Provider,
    }
}
fn field(value: &Value, name: &str, limit: usize) -> Result<String> {
    let text = value[name].as_str().ok_or(Code::Protocol)?;
    if text.is_empty() || text.len() > limit {
        return Err(Code::Payload);
    }
    Ok(text.to_owned())
}
#[derive(Debug)]
enum Command {
    Hello(u64),
    Start(u64, String),
    Append(u64, String, String, String),
    Close(u64),
}
#[derive(Default)]
struct State {
    last: u64,
    hello: bool,
    started: bool,
    ready: bool,
    handoffs: HashMap<String, String>,
    deliveries: HashSet<String>,
}
impl State {
    fn command(&mut self, value: Value) -> Result<Command> {
        if value["v"] != 1 {
            return Err(Code::Protocol);
        }
        let id = command_id(&value)
            .filter(|id| *id > self.last)
            .ok_or(Code::Protocol)?;
        let kind = value["type"].as_str().ok_or(Code::Protocol)?;
        let expected: &[&str] = match kind {
            "hello" | "close" => &["v", "type", "commandId"],
            "start" => &["v", "type", "commandId", "offer"],
            "append" => &["v", "type", "commandId", "handoffId", "deliveryId", "text"],
            _ => return Err(Code::Protocol),
        };
        let object = value.as_object().ok_or(Code::Protocol)?;
        if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
            return Err(Code::Protocol);
        }
        let command = match kind {
            "hello" if !self.hello && !self.started => {
                self.hello = true;
                Command::Hello(id)
            }
            "start" if self.hello && !self.started => {
                let offer = field(&value, "offer", 98_304)?;
                self.started = true;
                Command::Start(id, offer)
            }
            "append" if self.ready => {
                let handoff = field(&value, "handoffId", 256)?;
                let delivery = field(&value, "deliveryId", 256)?;
                let text = field(&value, "text", MAX_TEXT)?;
                if !self.handoffs.contains_key(&handoff)
                    || self.deliveries.len() >= MAX_IDS
                    || !self.deliveries.insert(delivery.clone())
                {
                    return Err(Code::Protocol);
                }
                Command::Append(id, handoff, delivery, text)
            }
            "close" => Command::Close(id),
            _ => return Err(Code::Protocol),
        };
        self.last = id;
        Ok(command)
    }
    fn handoff(&mut self, id: String, text: String) -> Result<Option<Value>> {
        if !self.ready
            || id.is_empty()
            || id.len() > 256
            || text.is_empty()
            || text.len() > MAX_TEXT
        {
            return Err(Code::Payload);
        }
        if let Some(previous) = self.handoffs.get(&id) {
            return if previous == &text {
                Ok(None)
            } else {
                Err(Code::Protocol)
            };
        }
        if self.handoffs.len() >= MAX_IDS {
            return Err(Code::Protocol);
        }
        self.handoffs.insert(id.clone(), text.clone());
        Ok(Some(
            json!({"v":1,"type":"handoff","handoffId":id,"text":text}),
        ))
    }
}

#[derive(Default)]
struct Transcript {
    index: u64,
    text: String,
}
impl Transcript {
    fn update(&mut self, role: &str, text: String, done: bool) -> Result<Option<Value>> {
        if !done && text.is_empty() {
            return Ok(None);
        }
        if done {
            if !text.is_empty() {
                self.text = text;
            }
            if self.text.is_empty() {
                self.index = self.index.checked_add(1).ok_or(Code::Payload)?;
                return Ok(None);
            }
        } else {
            if self.text.len().saturating_add(text.len()) > MAX_TEXT {
                return Err(Code::Payload);
            }
            self.text.push_str(&text);
        }
        if self.text.len() > MAX_TEXT {
            return Err(Code::Payload);
        }
        let event = json!({"v":1,"type":"transcript","itemId":format!("{role}-{}",self.index),"role":role,"text":self.text,"status":if done {"final"} else {"partial"}});
        if done {
            self.text.clear();
            self.index = self.index.checked_add(1).ok_or(Code::Payload)?;
        }
        Ok(Some(event))
    }
}

fn config() -> Result<RealtimeSessionConfig> {
    Ok(RealtimeSessionConfig {
        instructions: "You are NUAAI's conversational voice interface. Delegate tasks requiring tools or durable work to the client. The client owns permissions, tools and task execution. Speak verified client results; do not claim work or delivery before it is observed.".into(),
        initial_items: vec![], delegation_ack_filler: None, model: Some("gpt-live".into()), session_id: None,
        event_parser: RealtimeEventParser::FramelessBidi, session_mode: RealtimeSessionMode::Conversational,
        output_modality: RealtimeOutputModality::Audio,
        voice: serde_json::from_value(json!("marin")).map_err(|_| Code::Provider)?,
    })
}
fn provider() -> Provider {
    Provider {
        name: "subscription-webrtc-v3".into(),
        base_url: BASE.into(),
        query_params: None,
        headers: HeaderMap::new(),
        retry: RetryConfig {
            max_attempts: 0,
            base_delay: Duration::from_millis(1),
            retry_429: false,
            retry_5xx: false,
            retry_transport: false,
        },
        stream_idle_timeout: Duration::from_secs(60),
    }
}

// Native store/keyring APIs can block. Keep them off the stdio reactor, and bound
// each wait. Cancelling the helper never waits indefinitely for a keyring worker.
async fn native<T: Send + 'static>(
    operation: impl Future<Output = Result<T>> + Send + 'static,
) -> Result<T> {
    tokio::time::timeout(
        CLEANUP,
        tokio::task::spawn_blocking(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .map_err(|_| Code::Provider)?
                .block_on(operation)
        }),
    )
    .await
    .map_err(|_| Code::Authority)?
    .map_err(|_| Code::Authority)?
}
struct Authority {
    manager: std::sync::Arc<AuthManager>,
    snapshot: CodexAuth,
    frozen: SharedAuthProvider,
    // Keep permanently Unavailable auth controller separate from content authority.
    _auth_controller: NetworkPolicyController,
}
impl Authority {
    async fn load(home: PathBuf) -> Result<Self> {
        let (manager, controller) = read_manager(home).await;
        let (snapshot, frozen) = freeze_snapshot(manager.auth_cached())?;
        Ok(Self {
            manager: std::sync::Arc::new(manager),
            snapshot,
            frozen,
            _auth_controller: controller,
        })
    }
    async fn check(&self) -> Result<()> {
        let manager = self.manager.clone();
        let snapshot = self.snapshot.clone();
        native(async move {
            if manager
                .account_login_is_current(&snapshot)
                .await
                .map_err(|_| Code::Authority)?
            {
                Ok(())
            } else {
                Err(Code::Authority)
            }
        })
        .await
    }
}
async fn read_manager(home: PathBuf) -> (AuthManager, NetworkPolicyController) {
    let controller = NetworkPolicyController::default(); // Unavailable before constructor.
    let factory = HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault)
        .with_network_policy(controller.policy());
    let manager = AuthManager::new(
        home,
        false,
        AuthCredentialsStoreMode::Auto,
        None,
        Some("https://chatgpt.com".into()),
        AuthKeyringBackendKind::Direct,
        AuthRouteConfig::from_http_client_factory(factory),
    )
    .await;
    (manager, controller)
}
fn empty_auth_metadata() -> Value {
    json!({"stage":"not_started","managedChatgpt":false,"hasAccount":false,"hasUserId":false,
        "hasLoginOwner":false,"validUniqueHeaders":false,"ownerCheck":false,
        "loadMs":0,"ownerCheckMs":0,"elapsedMs":0})
}
fn snapshot_metadata(snapshot: Option<&CodexAuth>) -> Value {
    let mut report = empty_auth_metadata();
    if let Some(snapshot) = snapshot.filter(|auth| matches!(auth, CodexAuth::Chatgpt(_))) {
        report["managedChatgpt"] = json!(true);
        let account = snapshot.get_account_id();
        report["hasAccount"] = json!(account.as_ref().is_some_and(|value| !value.is_empty()));
        report["hasUserId"] = json!(
            snapshot
                .get_chatgpt_user_id()
                .is_some_and(|value| !value.is_empty())
        );
        report["hasLoginOwner"] = json!(
            snapshot
                .get_token_data()
                .ok()
                .and_then(|data| data.login_owner_id)
                .is_some_and(|value| !value.is_empty())
        );
        report["validUniqueHeaders"] = json!(
            codex_model_provider::auth_provider_from_auth(snapshot)
                .to_auth_headers()
                .ok()
                .is_some_and(|headers| account.as_ref().is_some_and(|account| {
                    crate::auth_guard::valid_bound_headers(&headers, account)
                }))
        );
    }
    report
}
/// Private metadata-only diagnosis. No content factory, refresh, raw errors or identity values.
/// Caller must have explicit review clearance before using a real managed home.
pub async fn auth_metadata(home: Option<PathBuf>) -> Value {
    let started = std::time::Instant::now();
    let report = std::sync::Arc::new(std::sync::Mutex::new(empty_auth_metadata()));
    if let Some(home) = home {
        let updated = report.clone();
        let result = native(async move {
            let loading = std::time::Instant::now();
            let (manager, _never_enable_auth) = read_manager(home).await;
            let snapshot = manager.auth_cached();
            let mut fields = snapshot_metadata(snapshot.as_ref());
            fields["loadMs"] = json!(loading.elapsed().as_millis() as u64);
            fields["stage"] = json!("snapshot_loaded");
            *updated.lock().map_err(|_| Code::Provider)? = fields;
            if let Some(snapshot) = snapshot.filter(|auth| matches!(auth, CodexAuth::Chatgpt(_))) {
                let checking = std::time::Instant::now();
                let checked = manager.account_login_is_current(&snapshot).await;
                let mut fields = updated.lock().map_err(|_| Code::Provider)?;
                fields["ownerCheckMs"] = json!(checking.elapsed().as_millis() as u64);
                fields["ownerCheck"] = json!(checked.as_ref().is_ok_and(|current| *current));
                fields["stage"] = json!(if checked.is_ok() {
                    "complete"
                } else {
                    "owner_check_error"
                });
            }
            Ok(())
        })
        .await;
        if result.is_err() {
            report.lock().expect("metadata lock")["stage"] = json!("native_read_incomplete");
        }
    } else {
        report.lock().expect("metadata lock")["stage"] = json!("missing_home");
    }
    let mut fields = report.lock().expect("metadata lock").clone();
    fields["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
    fields
}
fn freeze_snapshot(snapshot: Option<CodexAuth>) -> Result<(CodexAuth, SharedAuthProvider)> {
    let snapshot = snapshot.ok_or(Code::Login)?;
    // Managed ChatGPT only. No externally supplied headers/tokens/PAT/API key/agent auth.
    if !matches!(snapshot, CodexAuth::Chatgpt(_)) {
        return Err(Code::Login);
    }
    // Native managed ChatGPT identity, not a guessed plan-name entitlement gate.
    // Missing/new/free/paid plan metadata is not local voice authorization; service decides.
    let frozen = codex_model_provider::auth_provider_from_auth(&snapshot);
    let headers = frozen.to_auth_headers().map_err(|_| Code::Authority)?;
    validate_identity(
        true,
        snapshot.get_chatgpt_user_id().as_deref(),
        snapshot.get_account_id().as_deref(),
        &headers,
    )?;
    Ok((snapshot, frozen))
}

fn validate_identity(
    managed_chatgpt: bool,
    user: Option<&str>,
    account: Option<&str>,
    headers: &HeaderMap,
) -> Result<()> {
    if !managed_chatgpt {
        return Err(Code::Login);
    }
    if user.is_none_or(str::is_empty)
        || !crate::auth_guard::valid_bound_headers(headers, account.ok_or(Code::Authority)?)
    {
        return Err(Code::Authority);
    }
    Ok(())
}
fn forwardable(event: &RealtimeEvent) -> bool {
    match event {
        RealtimeEvent::HandoffRequested(_)
        | RealtimeEvent::InputTranscriptDone(_)
        | RealtimeEvent::OutputTranscriptDone(_) => true,
        RealtimeEvent::InputTranscriptDelta(delta)
        | RealtimeEvent::OutputTranscriptDelta(delta) => !delta.delta.is_empty(),
        _ => false,
    }
}
struct Content {
    factory: HttpClientFactory,
    controller: NetworkPolicyController,
}
impl Content {
    fn new() -> Result<Self> {
        let controller = NetworkPolicyController::default();
        // SDK sideband is the fixed public OpenAI /v1/live/{encoded call id} path.
        // HTTPS call authority and WSS origin ceiling are independent of auth networking.
        let policy = controller.policy().restrict_to_endpoints(
            [CALL_ENDPOINT.parse().map_err(|_| Code::Provider)?]
                .into_iter()
                .collect(),
        );
        let revision = policy.revision();
        if !controller.publish(revision, DestinationPolicy::Unrestricted) {
            return Err(Code::Provider);
        }
        // The factory for sideband has a separate fixed-origin ceiling below at join time.
        Ok(Self {
            factory: HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault)
                .with_network_policy(policy),
            controller,
        })
    }
}
impl Drop for Content {
    fn drop(&mut self) {
        self.controller
            .unavailable(self.controller.policy().revision());
    }
}

/// Nonblocking inherited integer descriptors. No Node stdio socketpair is accepted.
pub trait Wire {
    fn read(&self) -> impl Future<Output = Result<Option<Value>>>;
    fn write(&self, value: Value) -> impl Future<Output = Result<()>>;
}
#[derive(Default)]
struct Output {
    bytes: Vec<u8>,
    offset: usize,
}
pub struct Stdio {
    input: tokio::io::unix::AsyncFd<std::fs::File>,
    output: tokio::io::unix::AsyncFd<std::fs::File>,
    buffered: tokio::sync::Mutex<Output>,
}
impl Stdio {
    pub fn new(input: std::fs::File, output: std::fs::File) -> Result<Self> {
        Ok(Self {
            input: tokio::io::unix::AsyncFd::new(input).map_err(|_| Code::Provider)?,
            output: tokio::io::unix::AsyncFd::new(output).map_err(|_| Code::Provider)?,
            buffered: tokio::sync::Mutex::new(Output::default()),
        })
    }
    async fn write(&self, value: Value) -> Result<()> {
        tokio::time::timeout(CLEANUP, self.write_inner(value))
            .await
            .map_err(|_| Code::Provider)?
    }
    async fn write_inner(&self, value: Value) -> Result<()> {
        let mut bytes = Vec::new();
        wire::write_frame(&mut bytes, &value).map_err(codec_error)?;
        let mut buffered = self.buffered.lock().await;
        // If negotiation was cancelled mid-answer, finish its frame before closed/error.
        // Offset lives outside the cancelled future; never splice JSON into a partial frame.
        self.flush_buffer(&mut buffered).await?;
        buffered.bytes = bytes;
        buffered.offset = 0;
        self.flush_buffer(&mut buffered).await
    }
    async fn flush_buffer(&self, buffered: &mut Output) -> Result<()> {
        use std::io::Write;
        while buffered.offset < buffered.bytes.len() {
            let mut ready = self.output.writable().await.map_err(|_| Code::Provider)?;
            match ready.try_io(|fd| (&mut fd.get_ref()).write(&buffered.bytes[buffered.offset..])) {
                Ok(Ok(0)) | Ok(Err(_)) => return Err(Code::Provider),
                Ok(Ok(count)) => buffered.offset += count,
                Err(_) => {}
            }
        }
        buffered.bytes.clear();
        buffered.offset = 0;
        Ok(())
    }
    async fn read_exact(&self, bytes: &mut [u8], eof_ok: bool) -> Result<bool> {
        use std::io::Read;
        let mut offset = 0;
        while offset < bytes.len() {
            let mut ready = self.input.readable().await.map_err(|_| Code::Provider)?;
            match ready.try_io(|fd| (&mut fd.get_ref()).read(&mut bytes[offset..])) {
                Ok(Ok(0)) if offset == 0 && eof_ok => return Ok(false),
                Ok(Ok(0)) => return Err(Code::Protocol),
                Ok(Err(_)) => return Err(Code::Provider),
                Ok(Ok(count)) => offset += count,
                Err(_) => {}
            }
        }
        Ok(true)
    }
    async fn read(&self) -> Result<Option<Value>> {
        let mut prefix = [0; 4];
        if !self.read_exact(&mut prefix, true).await? {
            return Ok(None);
        }
        let len = u32::from_be_bytes(prefix) as usize;
        if len == 0 {
            return Err(Code::Protocol);
        }
        if len > MAX_FRAME {
            return Err(Code::Payload);
        }
        let mut bytes = vec![0; len + 4];
        bytes[..4].copy_from_slice(&prefix);
        self.read_exact(&mut bytes[4..], false).await?;
        wire::read_frame(&mut std::io::Cursor::new(bytes)).map_err(codec_error)
    }
}

struct BoundedTransport<T>(T);
impl<T: HttpTransport> HttpTransport for BoundedTransport<T> {
    async fn execute(&self, mut request: Request) -> std::result::Result<Response, TransportError> {
        if request.url != CALL_ENDPOINT || request.method != http::Method::POST {
            return Err(TransportError::Build(
                "subscription authority denied".into(),
            ));
        }
        request.timeout = Some(DEADLINE);
        request.response_body_limit_bytes = Some(MAX_FRAME);
        self.0.execute(request).await
    }
    async fn stream(&self, _: Request) -> std::result::Result<StreamResponse, TransportError> {
        Err(TransportError::Build(
            "subscription stream unsupported".into(),
        ))
    }
}
impl Wire for Stdio {
    async fn read(&self) -> Result<Option<Value>> {
        Stdio::read(self).await
    }
    async fn write(&self, value: Value) -> Result<()> {
        Stdio::write(self, value).await
    }
}
struct Live {
    authority: Authority,
    connection: RealtimeWebsocketConnection,
    _content: Content,
    _ws_controller: NetworkPolicyController,
}
impl Drop for Live {
    fn drop(&mut self) {
        self._ws_controller
            .unavailable(self._ws_controller.policy().revision());
    }
}
async fn start(home: Option<PathBuf>, offer: String, id: u64, io: &impl Wire) -> Result<Live> {
    let authority = native(Authority::load(home.ok_or(Code::Login)?)).await?;
    authority.check().await?; // immediately before native client construction
    let content = Content::new()?;
    let transport = ReqwestTransport::from_http_client(
        content
            .factory
            .build_client_without_request_logging(CALL_ENDPOINT, ClientRouteClass::Api)
            .map_err(|_| Code::Provider)?,
    );
    let call = RealtimeCallClient::new(
        BoundedTransport(transport),
        provider(),
        authority.frozen.clone(),
    )
    .create_with_session_and_headers(offer, config()?, HeaderMap::new())
    .await
    .map_err(api_error)?;
    authority.check().await?;
    if call.sdp.is_empty()
        || call.sdp.len() > 98_304
        || call.call_id.is_empty()
        || call.call_id.len() > 256
        || !call
            .call_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Code::Provider);
    }
    // Flush the actual answer BEFORE the SDK sideband join: browser must activate ICE.
    io.write(json!({"v":1,"type":"answer","commandId":id,"sdp":call.sdp}))
        .await?;
    let ws_controller = NetworkPolicyController::default();
    // FramelessBidi existing-call SDK adds NO query parameters (methods_common::websocket_intent).
    let endpoint = format!("wss://api.openai.com/v1/live/{}", call.call_id);
    let policy = ws_controller.policy().restrict_to_endpoints(
        [endpoint.parse().map_err(|_| Code::Provider)?]
            .into_iter()
            .collect(),
    );
    if !ws_controller.publish(policy.revision(), DestinationPolicy::Unrestricted) {
        return Err(Code::Provider);
    }
    authority.check().await?;
    let factory =
        HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault).with_network_policy(policy);
    let headers = authority
        .frozen
        .to_auth_headers()
        .map_err(|_| Code::Authority)?;
    let connection = RealtimeWebsocketClient::new(provider(), factory)
        .connect_existing_call_sideband(
            config()?,
            &call.call_id,
            headers,
            HeaderMap::new(),
            RealtimeTranscriptState::default(),
        )
        .await
        .map_err(api_error)?;
    authority.check().await?;
    Ok(Live {
        authority,
        connection,
        _content: content,
        _ws_controller: ws_controller,
    })
}

fn close_id(command: Option<Result<Value>>, state: &mut State) -> Result<Option<u64>> {
    match command {
        None => Ok(None),
        Some(Err(error)) => Err(error),
        Some(Ok(value)) => match state.command(value)? {
            Command::Close(id) => Ok(Some(id)),
            _ => Err(Code::Protocol),
        },
    }
}
async fn close(live: Option<&Live>, id: Option<u64>, io: &impl Wire) -> Result<()> {
    if let Some(live) = live {
        tokio::time::timeout(CLEANUP, live.connection.writer().close())
            .await
            .map_err(|_| Code::Cleanup)?
            .map_err(|_| Code::Cleanup)?;
    }
    if let Some(id) = id {
        io.write(json!({"v":1,"type":"closed","commandId":id}))
            .await?;
    }
    Ok(())
}

/// All command/provider work stays inside one cancellable session future. No backing thread.
pub async fn serve(home: Option<PathBuf>, io: &impl Wire) -> Result<()> {
    let result = session(home, io).await;
    if let Err(code) = result {
        let _ = tokio::time::timeout(
            CLEANUP,
            io.write(json!({"v":1,"type":"error","code":code.as_str()})),
        )
        .await;
    }
    result
}
async fn session(home: Option<PathBuf>, io: &impl Wire) -> Result<()> {
    let mut state = State::default();
    // A persistent read future is essential: selecting an SDK event must not discard a partial prefix.
    let mut read = Box::pin(io.read());
    let (id, offer) = loop {
        let frame = read.as_mut().await?;
        read = Box::pin(io.read());
        let Some(frame) = frame else {
            return Ok(());
        };
        match state.command(frame)? {
            Command::Hello(id) => io.write(json!({"v":1,"type":"hello","commandId":id,"profile":PROFILE,"interruption":"unsupported"})).await?,
            Command::Start(id, offer) => break (id, offer),
            Command::Close(id) => return close(None, Some(id), io).await,
            _ => return Err(Code::Protocol),
        }
    };
    let joined = {
        let joining = tokio::time::timeout(DEADLINE, start(home, offer, id, io));
        tokio::pin!(joining);
        tokio::select! {
            biased;
            command = read.as_mut() => {
                Err(close_id(command.transpose(), &mut state)?)
            },
            result = &mut joining => Ok(result.map_err(|_| Code::Timeout)??),
        }
    }; // Cancel/drop join (including partial writer guard) BEFORE writing closed.
    let live = match joined {
        Ok(live) => live,
        Err(id) => return close(None, id, io).await,
    };
    let next_event = || async {
        loop {
            let event = live
                .connection
                .next_event()
                .await
                .map_err(|_| Code::Disconnected)?
                .ok_or(Code::Disconnected)?;
            if matches!(event, RealtimeEvent::Error(_)) {
                return Err(Code::Provider);
            }
            if forwardable(&event) {
                live.authority.check().await?;
                return Ok::<_, Code>(event);
            }
            // Discard AudioOut/session metadata before any keyring/store owner check.
            // Cooperate even if the SDK's internal queue is already continuously ready.
            tokio::task::yield_now().await;
        }
    };
    let mut event = Box::pin(next_event());
    let mut transcripts = [Transcript::default(), Transcript::default()];
    type Dispatch<'a> = Pin<Box<dyn Future<Output = Result<Value>> + 'a>>;
    let mut pending: Option<Dispatch<'_>> = None;
    let mut queue = VecDeque::new();
    let outcome = async {
        state.ready = true;
        // start checked owner after join; no blocking store access in this reactor.
        io.write(json!({"v":1,"type":"control_ready","commandId":id})).await?;
        loop {
            if pending.is_none() && let Some(Command::Append(id, handoff, delivery, text)) = queue.pop_front() {
                let live = &live;
                pending = Some(Box::pin(async move {
                    live.authority.check().await?; // manual owner check, NOT an atomic lease
                    let writer = live.connection.writer().with_context_append_channel(RealtimeContextAppendChannel::Speakable);
                    let sent = tokio::time::timeout(Duration::from_secs(10), writer.send_conversation_handoff_append(handoff.clone(), text)).await;
                    live.authority.check().await?;
                    // Any SDK error/timeout may mean partial write; never retry or claim accepted.
                    let status = if matches!(sent, Ok(Ok(()))) { "accepted" } else { "unknown" };
                    Ok(json!({"v":1,"type":"delivery","commandId":id,"handoffId":handoff,"deliveryId":delivery,"status":status}))
                }));
            }
            tokio::select! {
                biased;
                command = read.as_mut() => {
                    read = Box::pin(io.read());
                    let Some(frame) = command? else { return Ok(None); };
                    match state.command(frame)? {
                        Command::Close(id) => return Ok(Some(id)),
                        command @ Command::Append(..) => {
                            if queue.len() + usize::from(pending.is_some()) >= 16 { return Err(Code::Protocol); }
                            queue.push_back(command);
                        },
                        _ => return Err(Code::Protocol),
                    }
                },
                result = async { pending.as_mut().expect("guarded pending").await }, if pending.is_some() => {
                    let event = result?;
                    pending = None;
                    io.write(event).await?;
                },
                received = event.as_mut() => {
                    let received = received?;
                    event = Box::pin(next_event());
                    let frame = match received {
                        RealtimeEvent::HandoffRequested(handoff) => state.handoff(handoff.handoff_id, handoff.input_transcript)?,
                        RealtimeEvent::InputTranscriptDelta(delta) => transcripts[0].update("user", delta.delta, false)?,
                        RealtimeEvent::InputTranscriptDone(done) => transcripts[0].update("user", done.text, true)?,
                        RealtimeEvent::OutputTranscriptDelta(delta) => transcripts[1].update("assistant", delta.delta, false)?,
                        RealtimeEvent::OutputTranscriptDone(done) => transcripts[1].update("assistant", done.text, true)?,
                        RealtimeEvent::Error(_) => return Err(Code::Provider),
                        _ => None, // AudioOut never crosses stdio; WebRTC owns media.
                    };
                    if let Some(frame) = frame { io.write(frame).await?; }
                },
            }
        }
    }.await;
    drop(pending); // cancel any unfinished SDK send before close, never revive delivery
    let cleanup = close(Some(&live), outcome.as_ref().ok().copied().flatten(), io).await;
    match (outcome, cleanup) {
        (Err(original), _) => Err(original),
        (_, Err(cleanup)) => Err(cleanup),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_is_only_fixed_metadata_never_native_identity_or_error_values() {
        let empty = snapshot_metadata(None);
        assert_eq!(
            empty,
            snapshot_metadata(Some(&CodexAuth::from_api_key(
                "fabricated-private-not-output"
            )))
        );
        let object = empty.as_object().unwrap();
        assert_eq!(object.len(), 10);
        for key in [
            "managedChatgpt",
            "hasAccount",
            "hasUserId",
            "hasLoginOwner",
            "validUniqueHeaders",
            "ownerCheck",
        ] {
            assert_eq!(object[key], false);
        }
        for key in ["loadMs", "ownerCheckMs", "elapsedMs"] {
            assert_eq!(object[key], 0);
        }
        assert_eq!(object["stage"], "not_started");
        assert!(!empty.to_string().contains("fabricated-private"));
        rt().block_on(async {
            assert_eq!(auth_metadata(None).await["stage"], "missing_home");
        });
    }
    #[test]
    fn strict_live_command_admission_and_delivery_correlation() {
        let mut state = State::default();
        assert!(
            state
                .command(json!({"v":1,"type":"start","commandId":1,"offer":"sdp"}))
                .is_err()
        );
        assert!(matches!(
            state.command(json!({"v":1,"type":"hello","commandId":1})),
            Ok(Command::Hello(1))
        ));
        assert!(
            state
                .command(json!({"v":1,"type":"hello","commandId":2}))
                .is_err()
        );
        assert!(state.command(json!({"v":1,"type":"start","commandId":2,"offer":"sdp","url":"https://evil.invalid"})).is_err());
        assert!(matches!(
            state.command(json!({"v":1,"type":"start","commandId":2,"offer":"sdp"})),
            Ok(Command::Start(2, _))
        ));
        let append = json!({"v":1,"type":"append","commandId":3,"handoffId":"A","deliveryId":"D","text":"result"});
        assert!(state.command(append.clone()).is_err());
        state.ready = true;
        state.handoff("A".into(), "task".into()).unwrap();
        assert!(
            matches!(state.command(append.clone()), Ok(Command::Append(3,h,d,t)) if h=="A" && d=="D" && t=="result")
        );
        assert!(state.command(append).is_err());
        assert!(state.command(json!({"v":1,"type":"append","commandId":4,"handoffId":"A","deliveryId":"D","text":"retry"})).is_err());
        assert!(matches!(
            state.command(json!({"v":1,"type":"close","commandId":4})),
            Ok(Command::Close(4))
        ));
    }
    #[test]
    fn transcript_roles_have_stable_ids_accumulation_final_and_utf8_limits() {
        let mut user = Transcript::default();
        let mut assistant = Transcript::default();
        assert_eq!(
            user.update("user", "hi".into(), false).unwrap().unwrap()["text"],
            "hi"
        );
        let event = user.update("user", " 🌱".into(), false).unwrap().unwrap();
        assert_eq!(event["text"], "hi 🌱");
        assert_eq!(event["itemId"], "user-0");
        assert_eq!(
            assistant
                .update("assistant", "hello".into(), true)
                .unwrap()
                .unwrap()["itemId"],
            "assistant-0"
        );
        let final_event = user
            .update("user", "corrected".into(), true)
            .unwrap()
            .unwrap();
        assert_eq!(final_event["status"], "final");
        assert_eq!(final_event["text"], "corrected");
        assert_eq!(
            user.update("user", "next".into(), false).unwrap().unwrap()["itemId"],
            "user-1"
        );
        assert_eq!(
            user.update("user", "🙂".repeat(4096), false),
            Err(Code::Payload)
        );
    }
    #[test]
    fn eligibility_and_error_mapping_never_export_upstream_bodies() {
        for (status, expected) in [
            (401, Code::Login),
            (402, Code::Subscription),
            (403, Code::Access),
            (429, Code::Rate),
            (500, Code::Provider),
        ] {
            let code = api_error(ApiError::Api {
                status: http::StatusCode::from_u16(status).unwrap(),
                message: "sensitive upstream body".into(),
            });
            assert_eq!(code, expected);
            assert!(!code.as_str().contains("sensitive"));
        }
        assert_eq!(api_error(ApiError::QuotaExceeded), Code::Quota);
        for (status, body, expected) in [
            (401, "private body", Code::Login),
            (403, "private body", Code::Access),
            (
                429,
                r#"{"error":{"code":"insufficient_quota","message":"private body"}}"#,
                Code::Quota,
            ),
            (429, "private body", Code::Rate),
        ] {
            assert_eq!(
                api_error(ApiError::Transport(TransportError::Http {
                    status: http::StatusCode::from_u16(status).unwrap(),
                    url: None,
                    headers: None,
                    body: Some(body.into()),
                    retry_after: None
                })),
                expected
            );
        }
        assert!(matches!(freeze_snapshot(None), Err(Code::Login)));
        assert!(matches!(
            freeze_snapshot(Some(CodexAuth::from_api_key("fabricated-only"))),
            Err(Code::Login)
        ));
    }
    #[test]
    fn managed_identity_is_plan_independent_but_authority_pair_is_required() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            "Bearer fabricated-test-only".parse().unwrap(),
        );
        headers.insert("chatgpt-account-id", "fabricated-account".parse().unwrap());
        for plan in [
            Value::Null,
            json!("free"),
            json!("unknown"),
            json!("new-plan-not-in-old-enum"),
            json!("plus"),
        ] {
            // A plan is metadata, not a local voice entitlement claim. Only identity
            // inputs are passed to the actual production validator; server decides tier.
            let metadata =
                json!({"plan":plan,"user":"fabricated-user","account":"fabricated-account"});
            assert_eq!(
                validate_identity(
                    true,
                    metadata["user"].as_str(),
                    metadata["account"].as_str(),
                    &headers
                ),
                Ok(())
            );
        }
        assert_eq!(
            validate_identity(false, Some("user"), Some("fabricated-account"), &headers),
            Err(Code::Login)
        );
        assert_eq!(
            validate_identity(true, None, Some("fabricated-account"), &headers),
            Err(Code::Authority)
        );
        assert_eq!(
            validate_identity(true, Some("user"), Some("different-account"), &headers),
            Err(Code::Authority)
        );
    }
    #[test]
    fn repeated_handoff_is_idempotent_but_changed_content_is_fatal() {
        let mut state = State {
            ready: true,
            ..State::default()
        };
        assert!(state.handoff("A".into(), "task".into()).unwrap().is_some());
        assert_eq!(state.handoff("A".into(), "task".into()), Ok(None));
        assert_eq!(state.handoffs.len(), 1);
        assert_eq!(
            state.handoff("A".into(), "changed task".into()),
            Err(Code::Protocol)
        );
        for index in 1..MAX_IDS {
            state.handoff(format!("id-{index}"), "task".into()).unwrap();
        }
        assert_eq!(
            state.handoff("overflow".into(), "task".into()),
            Err(Code::Protocol)
        );
        assert_eq!(state.handoff("A".into(), "task".into()), Ok(None));
    }
    #[test]
    fn silence_empty_delta_and_empty_done_never_emit_invalid_empty_text() {
        let mut transcript = Transcript::default();
        assert_eq!(transcript.update("user", String::new(), false), Ok(None));
        assert_eq!(transcript.index, 0);
        assert_eq!(transcript.update("user", String::new(), true), Ok(None));
        assert_eq!(transcript.index, 1);
        let partial = transcript
            .update("user", "nonempty".into(), false)
            .unwrap()
            .unwrap();
        assert_eq!(partial["itemId"], "user-1");
        let final_event = transcript
            .update("user", String::new(), true)
            .unwrap()
            .unwrap();
        assert_eq!(final_event["text"], "nonempty");
        assert_eq!(final_event["status"], "final");
        assert_eq!(transcript.index, 2);
        assert!(transcript.text.is_empty());
    }
    #[test]
    fn ignored_audio_metadata_and_empty_deltas_need_no_native_owner_lookup() {
        for event in [
            json!({"AudioOut":{"data":"fabricated-audio","sample_rate":24000,"num_channels":1}}),
            json!({"SessionUpdated":{"realtime_session_id":"fake"}}),
            json!({"InputTranscriptDelta":{"delta":""}}),
            json!({"OutputTranscriptDelta":{"delta":""}}),
        ] {
            let event: RealtimeEvent = serde_json::from_value(event).unwrap();
            assert!(!forwardable(&event));
        }
        for event in [
            json!({"InputTranscriptDelta":{"delta":"text"}}),
            json!({"OutputTranscriptDone":{"text":""}}),
            json!({"HandoffRequested":{"handoff_id":"A","item_id":"A","input_transcript":"task","active_transcript":[]}}),
        ] {
            assert!(forwardable(
                &serde_json::from_value::<RealtimeEvent>(event).unwrap()
            ));
        }
    }
    struct MemoryWire {
        input: std::sync::Mutex<VecDeque<Option<Value>>>,
        output: std::sync::Mutex<Vec<Value>>,
    }
    impl MemoryWire {
        fn new(frames: Vec<Option<Value>>) -> Self {
            Self {
                input: std::sync::Mutex::new(frames.into()),
                output: std::sync::Mutex::new(vec![]),
            }
        }
    }
    impl Wire for MemoryWire {
        async fn read(&self) -> Result<Option<Value>> {
            let next = self.input.lock().unwrap().pop_front();
            match next {
                Some(frame) => Ok(frame),
                None => std::future::pending().await,
            }
        }
        async fn write(&self, value: Value) -> Result<()> {
            self.output.lock().unwrap().push(value);
            Ok(())
        }
    }
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }
    #[test]
    fn hello_is_inert_and_missing_home_fails_only_on_start() {
        rt().block_on(async {
            let hello = json!({"v":1,"type":"hello","commandId":1});
            let io = MemoryWire::new(vec![Some(hello.clone()), None]);
            assert_eq!(serve(None, &io).await, Ok(()));
            assert_eq!(*io.output.lock().unwrap(), vec![json!({"v":1,"type":"hello","commandId":1,"profile":"subscription-webrtc-v3","interruption":"unsupported"})]);
            let io = MemoryWire::new(vec![Some(hello), Some(json!({"v":1,"type":"start","commandId":2,"offer":"synthetic SDP"}))]);
            assert_eq!(serve(None, &io).await, Err(Code::Login));
            assert_eq!(io.output.lock().unwrap()[1], json!({"v":1,"type":"error","code":"VOICE_CODEX_LOGIN_REQUIRED"}));
        });
    }
    #[test]
    fn close_and_eof_cancel_unpolled_start_without_store_or_network() {
        rt().block_on(async {
            for last in [Some(json!({"v":1,"type":"close","commandId":3})), None] {
                let io = MemoryWire::new(vec![
                    Some(json!({"v":1,"type":"hello","commandId":1})),
                    Some(json!({"v":1,"type":"start","commandId":2,"offer":"synthetic SDP"})),
                    last.clone(),
                ]);
                assert_eq!(serve(None, &io).await, Ok(()));
                let frames = io.output.lock().unwrap();
                assert_eq!(frames.len(), if last.is_some() { 2 } else { 1 });
                if last.is_some() {
                    assert_eq!(frames[1], json!({"v":1,"type":"closed","commandId":3}));
                }
            }
        });
    }
    #[test]
    fn malformed_command_fails_sanitized_and_closed_before_hello_is_safe() {
        rt().block_on(async {
            let io = MemoryWire::new(vec![Some(json!({"v":1,"type":"close","commandId":1}))]);
            assert_eq!(serve(None, &io).await, Ok(()));
            assert_eq!(
                io.output.lock().unwrap()[0],
                json!({"v":1,"type":"closed","commandId":1})
            );
            let io = MemoryWire::new(vec![Some(
                json!({"v":1,"type":"execute","commandId":1,"secret":"never echo"}),
            )]);
            assert_eq!(serve(None, &io).await, Err(Code::Protocol));
            assert_eq!(
                *io.output.lock().unwrap(),
                vec![json!({"v":1,"type":"error","code":"VOICE_PROTOCOL_ERROR"})]
            );
        });
    }
    struct RecordingTransport;
    impl HttpTransport for RecordingTransport {
        async fn execute(&self, request: Request) -> std::result::Result<Response, TransportError> {
            assert_eq!(request.url, CALL_ENDPOINT);
            assert_eq!(request.timeout, Some(DEADLINE));
            assert_eq!(request.response_body_limit_bytes, Some(MAX_FRAME));
            let prepared = request.prepare_body_for_send().unwrap();
            assert_eq!(
                prepared.headers["authorization"],
                "Bearer fabricated-test-only"
            );
            assert_eq!(prepared.headers["chatgpt-account-id"], "fabricated-account");
            let body: Value = serde_json::from_slice(&prepared.body.unwrap()).unwrap();
            assert_eq!(body["sdp"], "synthetic offer");
            assert_eq!(body["session"]["delegation"]["type"], "client");
            assert!(body["session"].get("id").is_none());
            let mut headers = HeaderMap::new();
            headers.insert("location", "/v1/realtime/calls/rtc_fake".parse().unwrap());
            Ok(Response {
                status: http::StatusCode::CREATED,
                headers,
                body: b"v=0\r\na=synthetic\r\n".to_vec().into(),
            })
        }
        async fn stream(&self, _: Request) -> std::result::Result<StreamResponse, TransportError> {
            panic!("no stream");
        }
    }
    #[test]
    fn actual_sdk_call_shape_matches_exact_policy_and_bounded_transport() {
        rt().block_on(async {
            let content = Content::new().unwrap();
            assert!(
                content
                    .factory
                    .network_policy()
                    .acquire(&CALL_ENDPOINT.parse().unwrap())
                    .is_ok()
            );
            assert!(
                content
                    .factory
                    .network_policy()
                    .acquire(
                        &"https://chatgpt.com/backend-api/codex/responses"
                            .parse()
                            .unwrap()
                    )
                    .is_err()
            );
            let auth = std::sync::Arc::new(codex_model_provider::BearerAuthProvider::for_test(
                Some("fabricated-test-only"),
                Some("fabricated-account"),
            ));
            let answer =
                RealtimeCallClient::new(BoundedTransport(RecordingTransport), provider(), auth)
                    .create_with_session_and_headers(
                        "synthetic offer".into(),
                        config().unwrap(),
                        HeaderMap::new(),
                    )
                    .await
                    .unwrap();
            assert_eq!(answer.call_id, "rtc_fake");
            assert_eq!(answer.sdp, "v=0\r\na=synthetic\r\n");
        });
    }
    fn fifo_pair() -> (Stdio, Stdio) {
        use std::os::fd::FromRawFd;
        unsafe extern "C" {
            fn pipe2(fds: *mut i32, flags: i32) -> i32;
        }
        let mut input = [-1; 2];
        let mut output = [-1; 2];
        assert_eq!(unsafe { pipe2(input.as_mut_ptr(), 0o2004000) }, 0);
        assert_eq!(unsafe { pipe2(output.as_mut_ptr(), 0o2004000) }, 0);
        // Owned local anonymous nonblocking pipes, not sockets or actual helper execution.
        unsafe {
            (
                Stdio::new(
                    std::fs::File::from_raw_fd(input[0]),
                    std::fs::File::from_raw_fd(output[1]),
                )
                .unwrap(),
                Stdio::new(
                    std::fs::File::from_raw_fd(output[0]),
                    std::fs::File::from_raw_fd(input[1]),
                )
                .unwrap(),
            )
        }
    }
    #[test]
    fn nonblocking_integer_stdio_really_serves_inert_hello_and_close() {
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let (helper, host) = fifo_pair();
                let (served, ()) = tokio::join!(serve(None, &helper), async {
                    host.write(json!({"v":1,"type":"hello","commandId":1}))
                        .await
                        .unwrap();
                    assert_eq!(host.read().await.unwrap().unwrap()["profile"], PROFILE);
                    host.write(json!({"v":1,"type":"close","commandId":2}))
                        .await
                        .unwrap();
                    assert_eq!(
                        host.read().await.unwrap(),
                        Some(json!({"v":1,"type":"closed","commandId":2}))
                    );
                });
                assert_eq!(served, Ok(()));
            });
    }
    #[test]
    fn cancelled_partial_stdout_frame_finishes_before_closed_without_corruption() {
        tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build().unwrap().block_on(async {
            let (helper, host) = fifo_pair();
            let answer = json!({"v":1,"type":"answer","commandId":2,"sdp":"a".repeat(98_304)});
            let mut prefix = [0;4];
            {
                let writing = helper.write(answer.clone()); tokio::pin!(writing);
                tokio::select! {
                    result = &mut writing => panic!("large write completed without draining: {result:?}"),
                    result = host.read_exact(&mut prefix, false) => assert!(result.unwrap()),
                }
            } // cancel mid-write, leaving persistent offset (not a partial JSON splice)
            let closed = json!({"v":1,"type":"closed","commandId":3});
            let (written, ()) = tokio::join!(helper.write(closed.clone()), async {
                let mut payload = vec![0; u32::from_be_bytes(prefix) as usize];
                host.read_exact(&mut payload, false).await.unwrap();
                assert_eq!(serde_json::from_slice::<Value>(&payload).unwrap(), answer);
                assert_eq!(host.read().await.unwrap(), Some(closed.clone()));
            });
            assert_eq!(written, Ok(()));
        });
    }
    #[test]
    fn codec_is_same_strict_frozen_wire_not_serde_value_only() {
        for payload in [
            r#"{"v":1,"type":"hello","commandId":1,"v":1}"#,
            r#"{"v":1,"type":"hello","commandId":1,"\u0076":1}"#,
            r#"{"nested":{"v":1}}"#,
        ] {
            let mut framed = (payload.len() as u32).to_be_bytes().to_vec();
            framed.extend(payload.as_bytes());
            assert_eq!(
                wire::read_frame(&mut std::io::Cursor::new(framed)),
                Err(wire::Error::Protocol)
            );
        }
    }
}
