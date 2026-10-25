//! Actual pinned SDK happy cycle. Synthetic existing call only; approved Docker NS only.
//! Not a helper codec, auth adapter, HTTP create, microphone or live-provider executable.
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("synthetic WS component requires Linux/x86_64");

use codex_api::{
    Provider, RealtimeContextAppendChannel, RealtimeEvent, RealtimeEventParser,
    RealtimeOutputModality, RealtimeSessionConfig, RealtimeSessionMode, RealtimeTranscriptState,
    RealtimeWebsocketClient, RetryConfig,
};
use codex_http_client::{
    DestinationPolicy, HttpClientFactory, NetworkPolicyController, OutboundProxyPolicy,
};
use http::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::process::ExitCode;
use std::time::Duration;

const BASE: &str = "http://127.0.0.1:38473/v1";
const ENDPOINT: &str = "ws://127.0.0.1:38473/v1/live/rtc_fixture_A";

unsafe extern "C" {
    fn syscall(number: i64, ...) -> i64;
}

fn isolate_descriptors() -> Result<(), &'static str> {
    let metadata =
        |fd| std::fs::metadata(format!("/proc/self/fd/{fd}")).map_err(|_| "stdio metadata");
    let input = metadata(0)?;
    let output = metadata(1)?;
    let error = metadata(2)?;
    let null = std::fs::metadata("/dev/null").map_err(|_| "null metadata")?;
    let uid = std::fs::metadata("/proc/self")
        .map_err(|_| "uid metadata")?
        .uid();
    if !input.file_type().is_char_device()
        || input.rdev() != null.rdev()
        || ![&output, &error].iter().all(|file| {
            file.is_file()
                && file.uid() == uid
                && file.mode() & 0o7777 == 0o600
                && file.nlink() == 1
        })
        || (output.dev(), output.ino()) == (error.dev(), error.ino())
    {
        return Err("regular private stdout/stderr and null stdin required");
    }
    // SAFETY: owned single-threaded Linux/x86_64 child, before runtime/SDK construction.
    // close_range(3, UINT_MAX, 0) removes inherited fixture/listener/IPC descriptors.
    if unsafe { syscall(436, 3_usize, usize::MAX, 0_usize) } != 0 {
        return Err("close_range failed");
    }
    Ok(())
}

fn valid_args(args: &[String]) -> bool {
    args == ["--fixture-port", "38473"]
}

fn result_text(id: &str) -> Option<String> {
    match id {
        "A" => Some(format!("A result: {}", "🌱".repeat(170))),
        "B" => Some(format!("B result: {}", "🙂".repeat(260))),
        _ => None,
    }
}

fn synthetic_config() -> Result<RealtimeSessionConfig, &'static str> {
    Ok(RealtimeSessionConfig {
        instructions: "Synthetic existing-call component; no tools or external actions.".into(),
        initial_items: vec![],
        delegation_ack_filler: None,
        model: Some("gpt-live".into()),
        session_id: Some("sdk-ws-fixture-session".into()),
        event_parser: RealtimeEventParser::FramelessBidi,
        session_mode: RealtimeSessionMode::Conversational,
        output_modality: RealtimeOutputModality::Audio,
        voice: serde_json::from_value(json!("marin")).map_err(|_| "voice")?,
    })
}

async fn happy_cycle() -> Result<Value, &'static str> {
    // Content-only controller; no AuthManager and no use of the auth DENY policy.
    let controller = NetworkPolicyController::default();
    let policy = controller.policy().restrict_to_endpoints(
        [ENDPOINT.parse().map_err(|_| "endpoint")?]
            .into_iter()
            .collect(),
    );
    let revision = policy.revision();
    // Exact endpoint ceiling + the separately validated private Docker network namespace.
    if !controller.publish(revision, DestinationPolicy::Unrestricted) {
        return Err("content policy publication");
    }
    let factory =
        HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault).with_network_policy(policy);
    let provider = Provider {
        name: "synthetic-existing-call-only".into(),
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
        stream_idle_timeout: Duration::from_secs(5),
    };
    let client =
        RealtimeWebsocketClient::new(provider, factory).with_webrtc_sideband_base_url(BASE.into());
    let config = synthetic_config()?;
    let mut headers = HeaderMap::new();
    headers.insert(
        http::header::AUTHORIZATION,
        HeaderValue::from_static("Bearer fixture-only-no-authority"),
    );
    headers.insert(
        "chatgpt-account-id",
        HeaderValue::from_static("fixture-account"),
    );
    let connection = client
        .connect_existing_call_sideband(
            config,
            "rtc_fixture_A",
            headers,
            HeaderMap::new(),
            RealtimeTranscriptState::default(),
        )
        .await
        .map_err(|_| "SDK existing-call join")?;

    let mut ids = Vec::new();
    let mut typed_events = Vec::new();
    for (expected_id, expected_text) in [("A", "fixture task A"), ("B", "fixture task B")] {
        let event = connection
            .next_event()
            .await
            .map_err(|_| "SDK reader")?
            .ok_or("SDK ended before handoffs")?;
        typed_events.push(serde_json::to_value(&event).map_err(|_| "typed event serialization")?);
        match event {
            RealtimeEvent::HandoffRequested(handoff)
                if handoff.handoff_id == expected_id
                    && handoff.item_id == expected_id
                    && handoff.input_transcript == expected_text =>
            {
                ids.push(handoff.handoff_id)
            }
            _ => return Err("unexpected typed SDK handoff"),
        }
    }
    let writer = connection
        .writer()
        .with_context_append_channel(RealtimeContextAppendChannel::Speakable);
    writer
        .send_conversation_handoff_append(ids[1].clone(), result_text("B").ok_or("B fixture")?)
        .await
        .map_err(|_| "SDK B append")?;
    writer
        .send_conversation_handoff_append(ids[0].clone(), result_text("A").ok_or("A fixture")?)
        .await
        .map_err(|_| "SDK A append")?;
    writer.close().await.map_err(|_| "SDK close")?; // One actual SDK close, not raw JSON.
    drop(writer);
    drop(connection);
    controller.unavailable(revision);
    Ok(json!({
        "v": 1, "component": "actual-sdk-existing-call-happy-cycle",
        "upstream": "6aaac694803004a63c6f393d153c96d22521a6b9",
        "call_id": "rtc_fixture_A", "http_creates": 0,
        "typed_events": typed_events, "result_order": [ids[1], ids[0]], "close_calls": 1,
    }))
}

fn run() -> Result<Value, &'static str> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !valid_args(&args) {
        return Err("exact fixed fixture-port argument required");
    }
    isolate_descriptors()?;
    for (key, _) in std::env::vars_os().collect::<Vec<_>>() {
        // SAFETY: owned single-threaded entry, before any runtime/SDK construction.
        unsafe {
            std::env::remove_var(key);
        }
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "runtime")?;
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(6), happy_cycle())
            .await
            .map_err(|_| "SDK deadline")?
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_fixture_arguments_are_accepted() {
        assert!(valid_args(&["--fixture-port".into(), "38473".into()]));
        for args in [
            vec![],
            vec!["--fixture-port".into(), "38474".into()],
            vec!["--url".into(), BASE.into()],
            vec!["--fixture-port".into(), "38473".into(), "extra".into()],
        ] {
            assert!(!valid_args(&args));
        }
    }

    #[test]
    fn unicode_results_require_multiple_utf8_chunks_and_bind_to_original_ids() {
        let a = result_text("A").unwrap();
        let b = result_text("B").unwrap();
        assert!(a.len() > 500 && b.len() > 1000);
        assert!(a.len() < 16_384 && b.len() < 16_384);
        assert!(a.starts_with("A result: ") && a.ends_with('🌱'));
        assert!(b.starts_with("B result: ") && b.ends_with('🙂'));
        assert_ne!(a, b);
        assert_eq!(result_text("other"), None);
    }

    #[test]
    fn configuration_is_fixed_frameless_audio_with_no_initial_items() {
        let config = synthetic_config().unwrap();
        assert_eq!(config.event_parser, RealtimeEventParser::FramelessBidi);
        assert_eq!(config.output_modality, RealtimeOutputModality::Audio);
        assert_eq!(config.session_id.as_deref(), Some("sdk-ws-fixture-session"));
        assert!(config.initial_items.is_empty());
        assert_eq!(config.delegation_ack_filler, None);
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(category) => {
            eprintln!("synthetic WS component failed: {category}");
            ExitCode::FAILURE
        }
    }
}
