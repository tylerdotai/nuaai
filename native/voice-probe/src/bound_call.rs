//! Explicit in-memory native B -> call-client composition proof. No auth constructor,
//! socket, arbitrary endpoint, credential output, or replacement AuthProvider.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use codex_api::{
    Provider, RealtimeCallClient, RealtimeEventParser, RealtimeOutputModality,
    RealtimeSessionConfig, RealtimeSessionMode, RetryConfig, SharedAuthProvider,
};
use codex_http_client::{HttpTransport, Request, Response, StreamResponse, TransportError};
use codex_login::{AuthManager, CodexAuth};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Value, json};

pub(super) const CASES: &[&str] = &[
    "bound_create_uses_B",
    "bound_owner_drift_before_create",
    "bound_frozen_B_after_rotation",
];
const OFFER: &str = "v=0\r\na=bound-offline-offer\r\n";
const ANSWER: &str = "v=0\r\na=bound-offline-answer\r\n";
const CALL_ID: &str = "rtc_bound_fixture";

struct CapturedRequest {
    headers: HeaderMap,
    body_is_native_v3: bool,
}

#[derive(Clone, Default)]
struct RecordingTransport {
    executions: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
}

impl HttpTransport for RecordingTransport {
    async fn execute(&self, request: Request) -> Result<Response, TransportError> {
        self.executions.fetch_add(1, Ordering::SeqCst);
        // Count every real execute entry, even if preparation fails.
        // The actual upstream transport seam finalizes native request bytes/headers here.
        let prepared = request
            .prepare_body_for_send()
            .map_err(|_| TransportError::Build("synthetic preparation failed".into()))?;
        let body = prepared
            .body
            .as_ref()
            .and_then(|body| serde_json::from_slice::<Value>(body).ok());
        let body_is_native_v3 = request.method == http::Method::POST
            && request.url
                == "https://offline.invalid/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
            && body.as_ref().is_some_and(|body| {
                body["sdp"] == OFFER
                    && body["session"]["delegation"]["type"] == "client"
                    && body["session"].get("id").is_none()
            });
        self.requests
            .lock()
            .map_err(|_| TransportError::Build("synthetic recorder unavailable".into()))?
            .push(CapturedRequest {
                headers: prepared.headers,
                body_is_native_v3,
            });
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::LOCATION,
            HeaderValue::from_static("/v1/realtime/calls/rtc_bound_fixture"),
        );
        Ok(Response {
            status: StatusCode::CREATED,
            headers,
            body: ANSWER.as_bytes().to_vec().into(),
        })
    }

    async fn stream(&self, _: Request) -> Result<StreamResponse, TransportError> {
        Err(TransportError::Build("synthetic stream unsupported".into()))
    }
}

fn provider_config() -> Provider {
    Provider {
        name: "bound-memory-only".into(),
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

fn session_config() -> Result<RealtimeSessionConfig, std::io::Error> {
    Ok(RealtimeSessionConfig {
        instructions: "Synthetic bound call. No tools or external actions.".into(),
        initial_items: vec![],
        delegation_ack_filler: None,
        model: Some("gpt-live".into()),
        session_id: None,
        event_parser: RealtimeEventParser::FramelessBidi,
        session_mode: RealtimeSessionMode::Conversational,
        output_modality: RealtimeOutputModality::Audio,
        voice: serde_json::from_value(json!("marin"))
            .map_err(|_| std::io::Error::other("synthetic voice invalid"))?,
    })
}

fn header_equals(headers: &HeaderMap, name: &str, expected: &str) -> bool {
    headers.get_all(name).iter().count() == 1
        && headers.get(name).and_then(|value| value.to_str().ok()) == Some(expected)
}

pub(super) async fn exercise(
    manager: &AuthManager,
    snapshot_a: &CodexAuth,
    snapshot_b: &CodexAuth,
    frozen_b: SharedAuthProvider,
) -> std::io::Result<Value> {
    // Allocate the real inert observer before admission; count0 is measured, never fabricated.
    let transport = RecordingTransport::default();
    let owner_current = manager.account_login_is_current(snapshot_b).await?;
    // Reject persisted owner drift before constructing or dispatching a native client.
    let admitted = owner_current;
    let mut response_valid = false;
    if admitted {
        let client = RealtimeCallClient::new(transport.clone(), provider_config(), frozen_b);
        let response = client
            .create_with_session_and_headers(OFFER.into(), session_config()?, HeaderMap::new())
            .await
            .map_err(|_| std::io::Error::other("synthetic native create failed"))?;
        response_valid = response.call_id == CALL_ID && response.sdp == ANSWER;
    }
    let requests = transport
        .requests
        .lock()
        .map_err(|_| std::io::Error::other("synthetic recorder unavailable"))?;
    let mut report = json!({
        "owner_current_before_create": owner_current,
        "admission_denied": !admitted, "call_client_constructed": admitted,
        "transport_executions": transport.executions.load(Ordering::SeqCst),
        "prepared_bearer_matches_B": null, "prepared_account_matches_B": null,
        "prepared_bearer_not_A": null, "prepared_bearer_not_C": null,
        "prepared_auth_count_one": null, "prepared_account_count_one": null,
        "prepared_content_type_json": null, "prepared_body_is_native_v3": null,
        "response_valid": response_valid,
    });
    if let Some(request) = requests.first() {
        let token_b = snapshot_b
            .get_token()
            .map_err(|_| std::io::Error::other("synthetic B token absent"))?;
        let token_a = snapshot_a
            .get_token()
            .map_err(|_| std::io::Error::other("synthetic A token absent"))?;
        let account_b = snapshot_b
            .get_account_id()
            .ok_or_else(|| std::io::Error::other("synthetic B account absent"))?;
        report["prepared_bearer_matches_B"] = json!(header_equals(
            &request.headers,
            "authorization",
            &format!("Bearer {token_b}")
        ));
        report["prepared_account_matches_B"] = json!(header_equals(
            &request.headers,
            "chatgpt-account-id",
            &account_b
        ));
        report["prepared_bearer_not_A"] = json!(!header_equals(
            &request.headers,
            "authorization",
            &format!("Bearer {token_a}")
        ));
        // C is the internally generated fixture token, not a second AuthProvider or reload.
        report["prepared_bearer_not_C"] = json!(!header_equals(
            &request.headers,
            "authorization",
            "Bearer fixture-access-C"
        ));
        report["prepared_auth_count_one"] =
            json!(request.headers.get_all("authorization").iter().count() == 1);
        report["prepared_account_count_one"] =
            json!(request.headers.get_all("chatgpt-account-id").iter().count() == 1);
        report["prepared_content_type_json"] = json!(header_equals(
            &request.headers,
            "content-type",
            "application/json"
        ));
        report["prepared_body_is_native_v3"] = json!(request.body_is_native_v3);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_prepared_header_comparison_rejects_duplicates_and_other_tokens() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer fixture-B"),
        );
        assert!(header_equals(&headers, "authorization", "Bearer fixture-B"));
        assert!(!header_equals(
            &headers,
            "authorization",
            "Bearer fixture-A"
        ));
        headers.append(
            "authorization",
            HeaderValue::from_static("Bearer fixture-B"),
        );
        assert!(!header_equals(
            &headers,
            "authorization",
            "Bearer fixture-B"
        ));
    }

    #[test]
    fn recorder_and_provider_configuration_are_inert_without_auth_or_io() {
        let recorder = RecordingTransport::default();
        assert_eq!(recorder.requests.lock().unwrap().len(), 0);
        assert_eq!(recorder.executions.load(Ordering::SeqCst), 0);
        let provider = provider_config();
        assert!(provider.headers.is_empty());
        assert_eq!(
            provider.base_url,
            "https://offline.invalid/backend-api/codex"
        );
        assert_eq!(provider.retry.max_attempts, 1);
        assert_eq!(CASES.len(), 3);
    }
}
