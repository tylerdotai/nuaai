//! Compile-only Linux feasibility probe. No auth construction or transport startup.

pub mod auth_guard;
#[cfg(feature = "subscription-voice")]
pub mod subscription_voice;

pub const UPSTREAM_COMMIT: &str = "6aaac694803004a63c6f393d153c96d22521a6b9";
pub const PROBE_PROTOCOL: u32 = 1;

/// Resolve the real exported function items without invoking them.
///
/// In particular, do not construct `AuthManager`: its constructor reads storage.
/// This surface is not a live helper and provides no arbitrary RPC forwarding.
pub fn check_public_symbols() {
    use codex_api::{
        RealtimeCallClient, RealtimeEventParser, RealtimeWebsocketClient,
        RealtimeWebsocketConnection, RealtimeWebsocketWriter, ReqwestTransport,
    };
    use codex_http_client::{HttpClientFactory, NetworkPolicy, NetworkPolicyController};
    use codex_login::{AuthManager, AuthRouteConfig, CodexAuth};

    let _ = RealtimeCallClient::<ReqwestTransport>::new;
    let _ = RealtimeCallClient::<ReqwestTransport>::create_with_session_and_headers;
    let _ = RealtimeWebsocketClient::new;
    let _ = RealtimeWebsocketClient::connect_webrtc_sideband;
    let _ = RealtimeWebsocketConnection::next_event;
    let _ = RealtimeWebsocketWriter::with_context_append_channel;
    let _ = RealtimeWebsocketWriter::send_conversation_handoff_append;
    let _ = RealtimeWebsocketWriter::send_conversation_item_create;
    let _ = RealtimeWebsocketWriter::close;
    let _ = RealtimeEventParser::FramelessBidi;
    let _ = AuthManager::new;
    let _ = AuthManager::auth_cached;
    let _ = AuthManager::account_login_is_current;
    let _ = AuthManager::auth_change_state_receiver;
    let _ = CodexAuth::from_auth_storage;
    let _ = AuthRouteConfig::from_http_client_factory;
    let _ = HttpClientFactory::with_network_policy;
    let _ = NetworkPolicyController::policy;
    let _ = NetworkPolicy::restrict_to_endpoints;
    let _ = codex_model_provider::auth_provider_from_auth;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_pinned_public_symbols_without_starting_auth_or_transport() {
        check_public_symbols();
        assert_eq!(PROBE_PROTOCOL, 1);
        assert_eq!(UPSTREAM_COMMIT, "6aaac694803004a63c6f393d153c96d22521a6b9");
    }
}
