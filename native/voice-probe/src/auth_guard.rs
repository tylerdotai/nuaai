//! Pure guards for the synthetic native-auth proof; never reads credentials or starts I/O.
use http::{HeaderMap, header::AUTHORIZATION};

pub fn valid_bound_headers(headers: &HeaderMap, expected_account: &str) -> bool {
    if expected_account.is_empty()
        || !expected_account.bytes().all(|byte| byte.is_ascii_graphic())
        || headers.get_all(AUTHORIZATION).iter().count() != 1
        || headers.get_all("chatgpt-account-id").iter().count() != 1
    {
        return false;
    }
    let Some(token) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    !token.is_empty()
        && token.len() <= 8192
        && token.bytes().all(|byte| byte.is_ascii_graphic())
        && headers
            .get("chatgpt-account-id")
            .and_then(|value| value.to_str().ok())
            == Some(expected_account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_api::AuthProvider;
    use codex_model_provider::BearerAuthProvider;

    fn headers(token: Option<&str>, account: Option<&str>) -> HeaderMap {
        // The upstream API can return Ok while silently omitting invalid headers.
        BearerAuthProvider::for_test(token, account)
            .to_auth_headers()
            .unwrap()
    }

    #[test]
    fn accepts_only_complete_bound_pair() {
        assert!(valid_bound_headers(
            &headers(Some("fixture-token"), Some("fixture-account")),
            "fixture-account"
        ));
        for (token, account) in [
            (None, Some("fixture-account")),
            (Some("fixture-token"), None),
            (Some(""), Some("fixture-account")),
            (Some("bad\nfixture-token"), Some("fixture-account")),
            (Some("fixture-token"), Some("bad\nfixture-account")),
            (Some("fixture-token"), Some("other-account")),
        ] {
            assert!(!valid_bound_headers(
                &headers(token, account),
                "fixture-account"
            ));
        }
    }

    #[test]
    fn rejects_duplicate_authorization_or_account_even_when_equal() {
        for name in ["authorization", "chatgpt-account-id"] {
            let mut duplicate = headers(Some("fixture-token"), Some("fixture-account"));
            duplicate.append(name, duplicate[name].clone());
            assert!(!valid_bound_headers(&duplicate, "fixture-account"));
        }
    }

    #[test]
    fn rejects_blank_or_ambiguous_bearer_and_account() {
        for authorization in [
            "Basic fixture",
            "Bearer ",
            "Bearer fixture token",
            "bearer fixture",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(AUTHORIZATION, authorization.parse().unwrap());
            headers.insert("chatgpt-account-id", "fixture-account".parse().unwrap());
            assert!(!valid_bound_headers(&headers, "fixture-account"));
        }
        assert!(!valid_bound_headers(
            &headers(Some("fixture-token"), Some("")),
            ""
        ));
    }
}
