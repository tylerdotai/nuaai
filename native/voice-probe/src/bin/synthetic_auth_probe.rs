//! Explicit synthetic FILE-only test executable. No caller-supplied homes, URLs, or credentials.
//! Run only through the independently validated syscall-denial harness, never as a live adapter.
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("Synthetic native auth descriptor isolation is Linux/x86_64 only");

use std::{collections::BTreeSet, os::unix::fs::FileTypeExt, path::Path, time::Duration};

unsafe extern "C" {
    fn syscall(number: i64, ...) -> i64;
}

fn isolated_descriptors() -> std::io::Result<()> {
    for fd in 0..=2 {
        if std::fs::metadata(format!("/proc/self/fd/{fd}"))?
            .file_type()
            .is_socket()
        {
            return Err(std::io::Error::other(
                "synthetic stdio must not inherit sockets",
            ));
        }
    }
    // Linux/x86_64 close_range(3, UINT_MAX, 0), before any temp home/runtime/auth.
    // SAFETY: this owned, explicitly invoked test child retains only non-socket stdio.
    if unsafe { syscall(436, 3_usize, usize::MAX, 0_usize) } != 0 {
        return Err(std::io::Error::other(
            "synthetic descriptor isolation failed",
        ));
    }
    Ok(())
}

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use codex_http_client::{
    HttpClientFactory, NetworkPolicy, NetworkPolicyController, NetworkPolicyDenied,
    OutboundProxyPolicy,
};
use codex_login::{
    AuthCredentialsStoreMode, AuthKeyringBackendKind, AuthManager, AuthRouteConfig, CodexAuth,
};
use nuaai_voice_probe::{UPSTREAM_COMMIT, auth_guard::valid_bound_headers};
use serde_json::{Value, json};

const BASE: &str = "http://127.0.0.1:9";
const CASES: &[&str] = &[
    "no_auth",
    "stored_api_key",
    "stored_pat",
    "env_pat",
    "stored_agent_jwt",
    "env_agent_jwt",
    "managed_same_owner",
    "managed_missing_token",
    "managed_invalid_bearer",
    "managed_missing_account",
    "managed_invalid_account_header",
    "managed_ab_account_switch",
    "managed_ab_user_switch",
    "managed_ab_login_owner_switch",
    "managed_ab_mode_switch",
    "managed_same_owner_token_rotation",
    "frozen_provider_after_store_drift",
    "managed_missing_user",
    "managed_missing_login_owner",
    "managed_free_plan",
    "managed_unknown_plan",
    "managed_ab_store_removed",
    "managed_idle_owner_switch",
];

fn is_fault_case(case: &str) -> bool {
    cfg!(feature = "synthetic-auth-faults")
        && matches!(
            case,
            "fault_unmanaged_factory_pat" | "fault_unmanaged_factory_agent"
        )
}

fn factory_for_case(case: &str, policy: &NetworkPolicy) -> HttpClientFactory {
    let factory = HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault);
    if is_fault_case(case) {
        // Explicit RED control only: same internally fabricated loopback fixture,
        // deliberately missing the native gate. The independent syscall belt MUST deny it.
        // Never publish/open a managed controller; never select this for a normal case.
        factory
    } else {
        factory.with_network_policy(policy.clone())
    }
}

fn jwt(claims: Value) -> String {
    format!(
        "{}.{}.fixture-signature",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","kid":"fixture"}"#),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    )
}

fn managed(
    account: Option<&str>,
    user: Option<&str>,
    owner: Option<&str>,
    token: &str,
    plan: &str,
) -> Value {
    json!({
        "auth_mode": "chatgpt",
        "tokens": {
            "id_token": jwt(json!({"https://api.openai.com/auth": {
                "chatgpt_account_id": account, "chatgpt_user_id": user, "chatgpt_plan_type": plan
            }})),
            "access_token": token, "refresh_token": "fixture-refresh-never-used",
            "account_id": account, "login_owner_id": owner,
            "oauth_provenance": {"issuer": BASE, "client_id": "fixture-client"}
        },
        "last_refresh": "2099-01-01T00:00:00Z"
    })
}

fn default_managed() -> Value {
    managed(
        Some("fixture-account"),
        Some("fixture-user"),
        Some("fixture-login"),
        "fixture-access-A",
        "plus",
    )
}

fn agent_jwt() -> String {
    jwt(
        json!({"iss": BASE, "aud": "fixture", "iat": 1, "exp": 4102444800_u64,
        "agent_runtime_id": "fixture-runtime", "agent_private_key": "fixture-not-a-key",
        "account_id": "fixture-account", "chatgpt_user_id": "fixture-user",
        "plan_type": "plus", "chatgpt_account_is_fedramp": false}),
    )
}

fn initial_fixture(case: &str) -> Option<Value> {
    Some(match case {
        "no_auth" | "env_pat" | "env_agent_jwt" => return None,
        "stored_api_key" => json!({"auth_mode": "apikey", "OPENAI_API_KEY": "fixture-api-key"}),
        "stored_pat" | "fault_unmanaged_factory_pat" => {
            json!({"auth_mode": "personalAccessToken", "personal_access_token": "at-fixture-only"})
        }
        "stored_agent_jwt" | "fault_unmanaged_factory_agent" => {
            json!({"auth_mode": "agentIdentity", "agent_identity": agent_jwt()})
        }
        "managed_missing_token" => {
            let mut value = default_managed();
            value["tokens"]
                .as_object_mut()
                .unwrap()
                .remove("access_token");
            value
        }
        "managed_invalid_bearer" => managed(
            Some("fixture-account"),
            Some("fixture-user"),
            Some("fixture-login"),
            "fixture\ninvalid",
            "plus",
        ),
        "managed_missing_account" => managed(
            None,
            Some("fixture-user"),
            Some("fixture-login"),
            "fixture-access-A",
            "plus",
        ),
        "managed_invalid_account_header" => managed(
            Some("fixture\ninvalid"),
            Some("fixture-user"),
            Some("fixture-login"),
            "fixture-access-A",
            "plus",
        ),
        "managed_missing_user" => managed(
            Some("fixture-account"),
            None,
            Some("fixture-login"),
            "fixture-access-A",
            "plus",
        ),
        "managed_missing_login_owner" => managed(
            Some("fixture-account"),
            Some("fixture-user"),
            None,
            "fixture-access-A",
            "plus",
        ),
        "managed_free_plan" => managed(
            Some("fixture-account"),
            Some("fixture-user"),
            Some("fixture-login"),
            "fixture-access-A",
            "free",
        ),
        "managed_unknown_plan" => managed(
            Some("fixture-account"),
            Some("fixture-user"),
            Some("fixture-login"),
            "fixture-access-A",
            "fixture-unknown-plan",
        ),
        _ => default_managed(),
    })
}

fn write_fixture(home: &Path, fixture: &Value) -> std::io::Result<()> {
    std::fs::write(home.join("auth.json"), serde_json::to_vec(fixture)?)
}

fn category(auth: Option<&CodexAuth>) -> &'static str {
    match auth {
        None => "none",
        Some(CodexAuth::Chatgpt(_)) => "managed",
        Some(_) => "nonmanaged",
    }
}

fn valid_identity(auth: &CodexAuth) -> bool {
    matches!(auth, CodexAuth::Chatgpt(_))
        && auth.get_chatgpt_user_id().is_some_and(|value| !value.trim().is_empty())
        && auth.get_token_data().is_ok_and(|data| data.login_owner_id.is_some_and(|value| !value.trim().is_empty()))
        // This proof deliberately permits only its fabricated Plus profile. Not service entitlement.
        && auth.account_plan_type().and_then(|plan| serde_json::to_value(plan).ok()) == Some(json!("plus"))
}

fn bootstrap_witness(error: &std::io::Error) -> &'static str {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(cause) = current {
        if matches!(
            cause.downcast_ref::<codex_http_client::HttpError>(),
            Some(codex_http_client::HttpError::Policy(
                NetworkPolicyDenied::Unavailable
            ))
        ) || matches!(
            cause.downcast_ref::<NetworkPolicyDenied>(),
            Some(NetworkPolicyDenied::Unavailable)
        ) {
            return "typed_unavailable";
        }
        // std::io::Error::source may skip its immediate boxed error's type.
        current = if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            io.get_ref()
                .map(|inner| inner as &(dyn std::error::Error + 'static))
        } else {
            cause.source()
        };
    }
    // PAT hydration formats its error into a String, erasing the typed cause.
    // Classify only this fixed request-site diagnostic; never print raw errors.
    let message = error.to_string();
    if message.starts_with("failed to request personal access token metadata:")
        && message.ends_with("application network policy is unavailable")
    {
        "pat_request_unavailable_message"
    } else {
        "unclassified_native_error"
    }
}

async fn run(case: &str, home: &Path) -> std::io::Result<Value> {
    // Keep this controller private and never publish any state. It starts Unavailable.
    let controller = NetworkPolicyController::default();
    let endpoints = [
        "/oauth/token",
        "/v1/user-auth-credential/whoami",
        "/agent-identities/jwks",
    ]
    .into_iter()
    .map(|path| format!("{BASE}{path}").parse().unwrap())
    .collect::<BTreeSet<_>>();
    let policy = controller.policy().restrict_to_endpoints(endpoints);
    let is_unavailable = || {
        matches!(
            policy.acquire(&format!("{BASE}/oauth/token").parse().unwrap()),
            Err(NetworkPolicyDenied::Unavailable)
        )
    };
    let before = is_unavailable();
    if !before {
        return Err(std::io::Error::other("synthetic policy invariant"));
    }
    let guarded = !is_fault_case(case);
    let route = AuthRouteConfig::from_http_client_factory(factory_for_case(case, &policy));
    // Explicit File and a freshly created synthetic path only. Never Auto/Keyring/default home.
    let stage_a = CodexAuth::from_auth_storage(
        home,
        AuthCredentialsStoreMode::File,
        Some(BASE),
        AuthKeyringBackendKind::Direct,
        &route,
    )
    .await;
    let category_a = match &stage_a {
        Ok(auth) => category(auth.as_ref()),
        Err(_) => "native_error",
    };
    let witness_a = stage_a.as_ref().err().map(bootstrap_witness);
    let snapshot_a = stage_a.ok().flatten();
    match case {
        "managed_ab_account_switch" => write_fixture(
            home,
            &managed(
                Some("fixture-account-B"),
                Some("fixture-user"),
                Some("fixture-login"),
                "fixture-access-B",
                "plus",
            ),
        )?,
        "managed_ab_user_switch" => write_fixture(
            home,
            &managed(
                Some("fixture-account"),
                Some("fixture-user-B"),
                Some("fixture-login"),
                "fixture-access-B",
                "plus",
            ),
        )?,
        "managed_ab_login_owner_switch" => write_fixture(
            home,
            &managed(
                Some("fixture-account"),
                Some("fixture-user"),
                Some("fixture-login-B"),
                "fixture-access-B",
                "plus",
            ),
        )?,
        "managed_ab_mode_switch" => write_fixture(
            home,
            &json!({"auth_mode": "apikey", "OPENAI_API_KEY": "fixture-api-key"}),
        )?,
        "managed_same_owner_token_rotation" => write_fixture(
            home,
            &managed(
                Some("fixture-account"),
                Some("fixture-user"),
                Some("fixture-login"),
                "fixture-access-B",
                "plus",
            ),
        )?,
        "managed_ab_store_removed" => std::fs::remove_file(home.join("auth.json"))?,
        _ => {}
    }
    if !is_unavailable() {
        return Err(std::io::Error::other("synthetic policy invariant"));
    }
    // Negative cases intentionally exercise BOTH public constructors under the same denial.
    // This is a test of constructors, not a production admission algorithm.
    let manager = AuthManager::new(
        home.to_path_buf(),
        false,
        AuthCredentialsStoreMode::File,
        None,
        Some(BASE.to_string()),
        AuthKeyringBackendKind::Direct,
        route,
    )
    .await;
    let snapshot_b = manager.auth_cached();
    let category_b = category(snapshot_b.as_ref());
    let owner_a = if let Some(auth) = &snapshot_a {
        Some(manager.account_login_is_current(auth).await?)
    } else {
        None
    };
    let owner_b = if let Some(auth) = &snapshot_b {
        Some(manager.account_login_is_current(auth).await?)
    } else {
        None
    };
    let mut report = json!({
        "version": 1, "case": case, "upstream_pin": UPSTREAM_COMMIT, "storage": "file",
        "auth_policy_before": if !guarded {"unmanaged_fault_control"} else if before {"unavailable"} else {"unexpected"},
        "measurement": if guarded {"normal_snapshot"} else {"fault_counterfactual"},
        "auth_factory_guarded": guarded,
        "auth_policy_after": "unexpected", "stageA": category_a, "stageB": category_b,
        "owner_checks": {"a_current": owner_a, "b_current": owner_b, "after_drift": null},
        "header_checks": {"bearer_present": null, "account_present": null, "account_matches_B": null, "token_matches_B": null, "unchanged_after_store_drift": null},
        "manager_watch_changed_after_drift": null, "drift_measurement": null,
        "bootstrap_witness_A": witness_a,
        "result": "rejected", "content_constructed": false, "refresh_invoked": false,
        "freshness": "not_validated"
    });
    if let Some(auth) = snapshot_b
        .as_ref()
        .filter(|auth| matches!(auth, CodexAuth::Chatgpt(_)))
    {
        // Public static bridge, NOT auth_provider_from_auth_manager (which may refresh).
        let provider = codex_model_provider::auth_provider_from_auth(auth);
        let headers = provider
            .to_auth_headers()
            .map_err(|_| std::io::Error::other("synthetic header resolution"))?;
        let account = auth.get_account_id().unwrap_or_default();
        report["header_checks"]["bearer_present"] = json!(headers.contains_key("authorization"));
        report["header_checks"]["account_present"] =
            json!(headers.contains_key("chatgpt-account-id"));
        report["header_checks"]["account_matches_B"] = json!(
            !account.is_empty()
                && headers
                    .get("chatgpt-account-id")
                    .and_then(|value| value.to_str().ok())
                    == Some(account.as_str())
        );
        report["header_checks"]["token_matches_B"] =
            json!(auth.get_token().ok().is_some_and(|token| {
                !token.is_empty()
                    && headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        == Some(format!("Bearer {token}").as_str())
            }));
        let identity_ok = snapshot_a.as_ref().is_some_and(valid_identity) && valid_identity(auth);
        let eligible = identity_ok
            && owner_a == Some(true)
            && owner_b == Some(true)
            && valid_bound_headers(&headers, &account);
        if eligible {
            report["result"] = json!("eligible_frozen_snapshot");
        }
        if matches!(
            case,
            "frozen_provider_after_store_drift" | "managed_idle_owner_switch"
        ) {
            let watch = manager.auth_change_state_receiver();
            write_fixture(
                home,
                &managed(
                    Some("fixture-account-C"),
                    Some("fixture-user-C"),
                    Some("fixture-login-C"),
                    "fixture-access-C",
                    "plus",
                ),
            )?;
            // The synchronous fixture write is complete. This is a manual metadata recheck,
            // NOT an idle lease guard, timer/renewal loop, transport revocation or close proof.
            report["drift_measurement"] = json!("manual_persisted_owner_recheck");
            let still_owner = manager.account_login_is_current(auth).await?;
            report["owner_checks"]["after_drift"] = json!(still_owner);
            report["manager_watch_changed_after_drift"] =
                json!(watch.has_changed().unwrap_or(false));
            report["header_checks"]["unchanged_after_store_drift"] = json!(
                provider
                    .to_auth_headers()
                    .map_err(|_| std::io::Error::other("synthetic frozen headers"))?
                    == headers
            );
            if !still_owner {
                report["result"] = json!("rejected");
            }
        }
    }
    report["auth_policy_after"] = json!(if !guarded {
        "unmanaged_fault_control"
    } else if is_unavailable() {
        "unavailable"
    } else {
        "unexpected"
    });
    Ok(report)
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 1 || args.get(1).is_some_and(|arg| arg == "--help") {
        println!("synthetic-auth-probe: --case <bounded synthetic case>; no live mode");
        return;
    }
    if args.len() != 3
        || args[1] != "--case"
        || !(CASES.contains(&args[2].as_str()) || is_fault_case(&args[2]))
    {
        std::process::exit(2);
    }
    // The marker is an additional operator guard, NOT proof of syscall containment.
    if std::env::var("NUAAI_SYNTHETIC_AUTH_FENCED").as_deref() != Ok("1") {
        std::process::exit(2);
    }
    let case = args[2].as_str();
    if is_fault_case(case)
        && std::env::var("NUAAI_SYNTHETIC_AUTH_FAULT_FENCED").as_deref() != Ok("1")
    {
        std::process::exit(2);
    }
    if isolated_descriptors().is_err() {
        std::process::exit(4);
    }
    let Ok(temp) = tempfile::Builder::new()
        .prefix("nuaai-synthetic-auth-")
        .tempdir()
    else {
        std::process::exit(3);
    };
    let home = temp.path().join("codex");
    if std::fs::create_dir(&home).is_err() {
        std::process::exit(3);
    }
    // SAFETY: single-threaded main before any Tokio runtime, native constructor, or child.
    // Even accidental inherited auth/proxy/issuer env cannot influence the public APIs.
    let names: Vec<_> = std::env::vars_os().map(|(name, _)| name).collect();
    unsafe {
        for name in names {
            std::env::remove_var(name);
        }
        std::env::set_var("HOME", temp.path());
        std::env::set_var("CODEX_HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", temp.path());
        std::env::set_var("XDG_DATA_HOME", temp.path());
        std::env::set_var("XDG_CACHE_HOME", temp.path());
        std::env::set_var("CODEX_AUTHAPI_BASE_URL", BASE);
        std::env::set_var("CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL", BASE);
        std::env::set_var("CODEX_AGENT_IDENTITY_JWKS_BASE_URL", BASE);
        match case {
            "env_pat" => std::env::set_var("CODEX_ACCESS_TOKEN", "at-fixture-only"),
            "env_agent_jwt" => std::env::set_var("CODEX_ACCESS_TOKEN", agent_jwt()),
            _ => {}
        }
    }
    if let Some(fixture) = initial_fixture(case) {
        if write_fixture(&home, &fixture).is_err() {
            std::process::exit(3);
        }
    }
    // No I/O/signal driver: enable_all initializes a Unix socketpair before auth.
    // Ordinary calls must stop at Unavailable; fault controls count only actual
    // constructor transport attempts denied BEFORE reactor registration, never an IO-off panic.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    match runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(5), run(case, &home)).await })
    {
        Ok(Ok(report)) => println!("{report}"),
        _ => std::process::exit(3),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_descriptor_guard_precedes_fixture_environment_runtime_and_auth() {
        // Pure source-order witness only; actual descriptor behavior is tested by eval's child.
        let source = include_str!("synthetic_auth_probe.rs");
        let main = source
            .split("fn main() {")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(main.contains(".enable_time()"));
        assert!(!main.contains(".enable_all()") && !main.contains(".enable_io()"));
        let guard = main.find("if isolated_descriptors().is_err()").unwrap();
        for operation in [
            "let Ok(temp)",
            "std::env::vars_os()",
            "initial_fixture(case)",
            "tokio::runtime::Builder",
        ] {
            assert!(guard < main.find(operation).unwrap());
        }
        let fd_guard = source
            .split("fn isolated_descriptors()")
            .nth(1)
            .unwrap()
            .split("use base64")
            .next()
            .unwrap();
        assert!(
            fd_guard.find(".is_socket()").unwrap()
                < fd_guard
                    .find("syscall(436, 3_usize, usize::MAX, 0_usize)")
                    .unwrap()
        );
    }

    #[test]
    fn cases_are_unique_and_fixtures_use_public_storage_schema_without_io() {
        assert_eq!(CASES.len(), 23);
        assert_eq!(CASES.iter().collect::<BTreeSet<_>>().len(), CASES.len());
        for case in CASES {
            if let Some(fixture) = initial_fixture(case) {
                let parsed = serde_json::from_value::<codex_login::AuthDotJson>(fixture);
                assert_eq!(parsed.is_err(), *case == "managed_missing_token", "{case}");
            }
        }
    }

    #[test]
    fn normal_factories_stay_unavailable_even_with_fault_feature_enabled() {
        let controller = NetworkPolicyController::default();
        let policy = controller.policy();
        let endpoint = format!("{BASE}/oauth/token").parse().unwrap();
        for case in CASES {
            assert!(!is_fault_case(case));
            assert!(matches!(
                factory_for_case(case, &policy)
                    .network_policy()
                    .acquire(&endpoint),
                Err(NetworkPolicyDenied::Unavailable)
            ));
        }
        for case in [
            "fault_unmanaged_factory_pat",
            "fault_unmanaged_factory_agent",
        ] {
            assert_eq!(is_fault_case(case), cfg!(feature = "synthetic-auth-faults"));
            let permit = factory_for_case(case, &policy)
                .network_policy()
                .acquire(&endpoint);
            assert_eq!(permit.is_ok(), cfg!(feature = "synthetic-auth-faults"));
            assert!(
                serde_json::from_value::<codex_login::AuthDotJson>(initial_fixture(case).unwrap())
                    .is_ok()
            );
        }
    }

    #[test]
    fn distinguishes_typed_policy_request_site_message_and_unclassified_failure() {
        let typed = std::io::Error::other(codex_http_client::HttpError::Policy(
            NetworkPolicyDenied::Unavailable,
        ));
        assert_eq!(bootstrap_witness(&typed), "typed_unavailable");
        let lossy = std::io::Error::other(
            "failed to request personal access token metadata: application network policy is unavailable",
        );
        assert_eq!(bootstrap_witness(&lossy), "pat_request_unavailable_message");
        let unrelated = std::io::Error::other("synthetic parse rejection");
        assert_eq!(bootstrap_witness(&unrelated), "unclassified_native_error");
    }
}
