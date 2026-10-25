//! Standalone exact-pin public API tests. In-memory HttpTransport only: no sockets,
//! AuthManager, auth stores, provider services, stdio helper or daemon integration.
use codex_api::{
    AuthError, AuthProvider, AuthRefreshFuture, Provider, RealtimeCallClient, RealtimeEventParser,
    RealtimeOutputModality, RealtimeSessionConfig, RealtimeSessionMode, RetryConfig,
    session_update_session_json,
};
use codex_http_client::{
    HttpTransport, Request, RequestBody, Response, StreamResponse, TransportError,
};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const OFFER: &str = "v=0\r\na=offline-fixture-offer\r\n";
const ANSWER: &str = "v=0\r\na=offline-fixture-answer\r\n";
const SYNTHETIC_AUTH: &str = "Bearer fixture-only-no-authority";
const SYNTHETIC_ACCOUNT: &str = "fixture-account";

#[derive(Clone)]
struct RecordingTransport {
    requests: Arc<Mutex<Vec<Request>>>,
    location: Option<&'static str>,
    body: Vec<u8>,
    status: StatusCode,
}
impl RecordingTransport {
    fn new(location: Option<&'static str>) -> Self {
        Self {
            requests: Arc::default(),
            location,
            body: ANSWER.as_bytes().to_vec(),
            status: StatusCode::CREATED,
        }
    }
    fn attempts(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
impl HttpTransport for RecordingTransport {
    async fn execute(&self, request: Request) -> Result<Response, TransportError> {
        self.requests.lock().unwrap().push(request);
        if !self.status.is_success() {
            return Err(TransportError::Http {
                status: self.status,
                url: None,
                headers: None,
                body: Some("synthetic rejection".into()),
                retry_after: None,
            });
        }
        let mut headers = HeaderMap::new();
        if let Some(location) = self.location {
            headers.insert(http::header::LOCATION, HeaderValue::from_static(location));
        }
        Ok(Response {
            status: self.status,
            headers,
            body: self.body.clone().into(),
        })
    }
    async fn stream(&self, _: Request) -> Result<StreamResponse, TransportError> {
        panic!("stream is not a realtime call-create operation")
    }
}
#[derive(Default)]
struct SyntheticAuth {
    applied: AtomicUsize,
    refresh_callbacks: AtomicUsize,
    reject: bool,
}
impl AuthProvider for SyntheticAuth {
    fn add_auth_headers(&self, headers: &mut HeaderMap) -> Result<(), AuthError> {
        self.applied.fetch_add(1, Ordering::SeqCst);
        if self.reject {
            return Err(AuthError::Build("synthetic preflight rejection".into()));
        }
        headers.insert(
            http::header::AUTHORIZATION,
            HeaderValue::from_static(SYNTHETIC_AUTH),
        );
        headers.insert(
            "chatgpt-account-id",
            HeaderValue::from_static(SYNTHETIC_ACCOUNT),
        );
        Ok(())
    }
    fn refresh_after_unauthorized(&self, _: HeaderMap) -> AuthRefreshFuture<'_> {
        self.refresh_callbacks.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { false }) // No refresh implementation or network path exists here.
    }
}
fn provider() -> Provider {
    Provider {
        name: "offline-memory-only".into(),
        // Reserved .invalid name is serialized into Request, never resolved or connected.
        base_url: "https://offline.invalid/backend-api/codex".into(),
        query_params: None,
        headers: HeaderMap::new(),
        retry: RetryConfig {
            max_attempts: 1,
            base_delay: Duration::from_millis(1),
            retry_429: false,
            retry_5xx: false,
            retry_transport: false,
        },
        stream_idle_timeout: Duration::from_secs(1),
    }
}
fn config() -> RealtimeSessionConfig {
    RealtimeSessionConfig {
        instructions: "Offline protocol fixture. No tools or external actions.".into(),
        initial_items: vec![],
        delegation_ack_filler: None,
        model: Some("gpt-live".into()),
        session_id: Some("must-not-leak-into-v3-session".into()),
        event_parser: RealtimeEventParser::FramelessBidi,
        session_mode: RealtimeSessionMode::Conversational,
        output_modality: RealtimeOutputModality::Audio,
        voice: serde_json::from_value(json!("marin")).unwrap(),
    }
}
fn expected_session() -> Value {
    json!({
        "model": "gpt-live",
        "instructions": "Offline protocol fixture. No tools or external actions.",
        "audio": { "output": { "voice": "marin" } },
        "delegation": { "type": "client" },
    })
}
fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    // No IO driver; in-memory transport futures do not open sockets or spawn a runtime service.
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn public_v3_session_serializer_is_invoked_with_exact_no_vad_no_tools_shape() {
    let actual = session_update_session_json(config()).unwrap();
    assert_eq!(actual, expected_session());
    assert!(actual.get("id").is_none());
    assert!(actual["audio"].get("input").is_none());
    assert!(actual.get("tools").is_none());
    assert!(actual.get("turn_detection").is_none());
}

#[test]
fn actual_call_client_captures_backend_v3_url_body_static_auth_and_location_id() {
    let transport = RecordingTransport::new(Some("/v1/realtime/calls/rtc_fixture_A"));
    let auth = Arc::new(SyntheticAuth::default());
    let client = RealtimeCallClient::new(transport.clone(), provider(), auth.clone());
    let response =
        run(client.create_with_session_and_headers(OFFER.into(), config(), HeaderMap::new()))
            .unwrap();
    assert_eq!(response.sdp, ANSWER);
    assert_eq!(response.call_id, "rtc_fixture_A");
    assert_eq!(transport.attempts(), 1);
    assert_eq!(auth.applied.load(Ordering::SeqCst), 1);
    assert_eq!(auth.refresh_callbacks.load(Ordering::SeqCst), 0);
    let requests = transport.requests.lock().unwrap();
    let request = &requests[0];
    assert_eq!(request.method, http::Method::POST);
    assert_eq!(
        request.url,
        "https://offline.invalid/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
    );
    // Content-Type and JSON bytes are finalized by this actual upstream method,
    // not by EndpointSession before the injectable transport is called.
    let prepared = request.prepare_body_for_send().unwrap();
    assert_eq!(
        prepared.headers[http::header::CONTENT_TYPE],
        "application/json"
    );
    let wire: Value = serde_json::from_slice(prepared.body.as_ref().unwrap()).unwrap();
    assert_eq!(wire, json!({ "sdp": OFFER, "session": expected_session() }));
    assert_eq!(request.headers[http::header::AUTHORIZATION], SYNTHETIC_AUTH);
    assert_eq!(request.headers["chatgpt-account-id"], SYNTHETIC_ACCOUNT);
    match request.body.as_ref().unwrap() {
        RequestBody::Json(body) => assert_eq!(
            body,
            &json!({ "sdp": OFFER, "session": expected_session() })
        ),
        _ => panic!("backend V3 call must use actual JSON request body"),
    }
}

#[test]
fn actual_call_client_rejects_missing_and_unsupported_location_ids_without_recreate() {
    for location in [
        None,
        Some("/v1/realtime/calls/fixture-call-A"),
        Some("/v1/live/rtc_"),
    ] {
        let transport = RecordingTransport::new(location);
        let client = RealtimeCallClient::new(
            transport.clone(),
            provider(),
            Arc::new(SyntheticAuth::default()),
        );
        assert!(
            run(client.create_with_session_and_headers(OFFER.into(), config(), HeaderMap::new()))
                .is_err()
        );
        assert_eq!(transport.attempts(), 1);
    }
}

#[test]
fn actual_call_client_accepts_uuid_location_id_and_ignores_location_query() {
    for (location, expected) in [
        ("/v1/live/rtc_fixture_A?ignored=value", "rtc_fixture_A"),
        (
            "/v1/realtime/calls/12345678-1234-abcd-ABCD-0123456789ab",
            "12345678-1234-abcd-ABCD-0123456789ab",
        ),
    ] {
        let transport = RecordingTransport::new(Some(location));
        let client = RealtimeCallClient::new(
            transport.clone(),
            provider(),
            Arc::new(SyntheticAuth::default()),
        );
        let response =
            run(client.create_with_session_and_headers(OFFER.into(), config(), HeaderMap::new()))
                .unwrap();
        assert_eq!(response.call_id, expected);
        assert_eq!(transport.attempts(), 1);
    }
}

#[test]
fn actual_call_client_rejects_v2_before_auth_and_transport() {
    let transport = RecordingTransport::new(Some("/v1/live/rtc_fixture_A"));
    let auth = Arc::new(SyntheticAuth::default());
    let client = RealtimeCallClient::new(transport.clone(), provider(), auth.clone());
    let mut session = config();
    session.event_parser = RealtimeEventParser::RealtimeV2;
    assert!(
        run(client.create_with_session_and_headers(OFFER.into(), session, HeaderMap::new()))
            .is_err()
    );
    assert_eq!(transport.attempts(), 0);
    assert_eq!(auth.applied.load(Ordering::SeqCst), 0);
}

#[test]
fn actual_call_client_fails_401_once_without_refresh_or_retry() {
    let mut transport = RecordingTransport::new(Some("/v1/live/rtc_fixture_A"));
    transport.status = StatusCode::UNAUTHORIZED;
    let auth = Arc::new(SyntheticAuth::default());
    let client = RealtimeCallClient::new(transport.clone(), provider(), auth.clone());
    assert!(
        run(client.create_with_session_and_headers(OFFER.into(), config(), HeaderMap::new()))
            .is_err()
    );
    assert_eq!(transport.attempts(), 1);
    assert_eq!(auth.applied.load(Ordering::SeqCst), 1);
    assert_eq!(auth.refresh_callbacks.load(Ordering::SeqCst), 0);
}

#[test]
fn static_auth_failure_prevents_even_in_memory_transport_execution() {
    let transport = RecordingTransport::new(Some("/v1/live/rtc_fixture_A"));
    let auth = Arc::new(SyntheticAuth {
        reject: true,
        ..Default::default()
    });
    let client = RealtimeCallClient::new(transport.clone(), provider(), auth.clone());
    assert!(
        run(client.create_with_session_and_headers(OFFER.into(), config(), HeaderMap::new()))
            .is_err()
    );
    assert_eq!(transport.attempts(), 0);
    assert_eq!(auth.applied.load(Ordering::SeqCst), 1);
    assert_eq!(auth.refresh_callbacks.load(Ordering::SeqCst), 0);
}

#[test]
fn invalid_utf8_sdp_answer_fails_without_recreate() {
    let mut transport = RecordingTransport::new(Some("/v1/live/rtc_fixture_A"));
    transport.body = vec![0xff];
    let client = RealtimeCallClient::new(
        transport.clone(),
        provider(),
        Arc::new(SyntheticAuth::default()),
    );
    assert!(
        run(client.create_with_session_and_headers(OFFER.into(), config(), HeaderMap::new()))
            .is_err()
    );
    assert_eq!(transport.attempts(), 1);
}
