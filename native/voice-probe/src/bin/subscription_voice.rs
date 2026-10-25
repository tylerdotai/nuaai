//! Trusted local subscription helper, no arguments, no auth before start.
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("subscription helper descriptor isolation requires Linux/x86_64");
use nuaai_voice_probe::subscription_voice::{Code, Stdio, serve};
use std::{
    ffi::OsString,
    os::{
        fd::{FromRawFd, RawFd},
        unix::fs::FileTypeExt,
    },
    path::PathBuf,
};
unsafe extern "C" {
    fn syscall(number: i64, ...) -> i64;
    fn fcntl(fd: RawFd, operation: i32, ...) -> i32;
}
fn allowed_env(name: &str) -> bool {
    matches!(name, "HOME" | "CODEX_HOME" | "PATH" | "LANG" | "TZ")
}
fn authority_env(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    name.contains("PROXY")
        || name.contains("API_KEY")
        || name.contains("ACCESS_TOKEN")
        || name.contains("AUTH_TOKEN")
        || name.contains("BASE_URL")
        || name.contains("ENDPOINT")
        || name.starts_with("OPENAI_")
        || name.starts_with("CODEX_") && name != "CODEX_HOME"
        || matches!(
            name.as_str(),
            "SSL_CERT_FILE"
                | "SSL_CERT_DIR"
                | "REQUESTS_CA_BUNDLE"
                | "CURL_CA_BUNDLE"
                | "NODE_EXTRA_CA_CERTS"
        )
}
fn prepare() -> Result<Option<PathBuf>, Code> {
    if std::env::args_os().len() != 1 {
        return Err(Code::Protocol);
    }
    for fd in 0..=2 {
        if !std::fs::metadata(format!("/proc/self/fd/{fd}"))
            .is_ok_and(|metadata| !metadata.file_type().is_socket())
        {
            return Err(Code::Authority);
        }
    }
    // SAFETY: sole owned entry thread; remove every inherited descriptor except stdio.
    if unsafe { syscall(436, 3_usize, usize::MAX, 0_usize) } != 0 {
        return Err(Code::Authority);
    }
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    if env
        .iter()
        .any(|(name, _)| name.to_str().is_some_and(authority_env))
    {
        return Err(Code::Authority);
    }
    let mut home = None;
    let mut codex = None;
    for (name, value) in env {
        match name.to_str() {
            Some("HOME") => home = Some(PathBuf::from(&value)),
            Some("CODEX_HOME") => codex = Some(PathBuf::from(&value)),
            _ => {}
        }
        if !name.to_str().is_some_and(allowed_env) {
            // SAFETY: before runtime/threads/SDK. Preserve only trusted non-credential host paths.
            unsafe {
                std::env::remove_var(name);
            }
        }
    }
    let path = codex.or_else(|| home.map(|home| home.join(".codex")));
    if path.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err(Code::Authority);
    }
    for fd in [0, 1] {
        // Linux F_GETFL/F_SETFL + O_NONBLOCK. AsyncFd never performs blocking FIFO I/O.
        let flags = unsafe { fcntl(fd, 3) };
        if flags < 0 || unsafe { fcntl(fd, 4, flags | 0o4000) } < 0 {
            return Err(Code::Authority);
        }
    }
    Ok(path)
}
fn run() -> Result<(), Code> {
    let home = prepare()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|_| Code::Provider)?;
    let result = runtime.block_on(async move {
        // SAFETY: inherited private stdio, now uniquely owned and nonblocking.
        let io = Stdio::new(unsafe { std::fs::File::from_raw_fd(0) }, unsafe {
            std::fs::File::from_raw_fd(1)
        })?;
        serve(home, &io).await
    });
    // Native read-only keyring calls are not forcibly interruptible. They run only in
    // owned blocking workers; process exit must not wait for a stalled desktop bus.
    runtime.shutdown_timeout(std::time::Duration::from_millis(50));
    result
}
fn main() {
    // No tracing subscriber: upstream SDP/token/error tracing cannot reach stderr.
    if run().is_err() {
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_inherited_endpoint_api_key_or_proxy_authority() {
        for name in [
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "OPENAI_BASE_URL",
            "HTTPS_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "SSL_CERT_FILE",
            "CODEX_AUTH_JSON",
            "CODEX_HOME_OVERRIDE",
        ] {
            assert!(authority_env(name), "{name}");
        }
        for name in ["HOME", "CODEX_HOME", "PATH", "LANG", "TZ"] {
            assert!(allowed_env(name));
            assert!(!authority_env(name));
        }
        assert!(!allowed_env("RUST_LOG"));
        assert!(!allowed_env("LD_PRELOAD"));
    }
}
