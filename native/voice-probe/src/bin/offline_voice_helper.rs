//! Explicit offline-memory-v1 helper. No auth constructors or live/network mode.
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("Offline helper descriptor isolation is Linux/x86_64 only");
use std::os::unix::fs::FileTypeExt;
#[path = "../offline_helper.rs"]
mod helper;
unsafe extern "C" {
    fn syscall(number: i64, ...) -> i64;
}
fn main() {
    if std::env::args_os().len() != 1 {
        std::process::exit(2);
    }
    for fd in 0..=2 {
        if !std::fs::metadata(format!("/proc/self/fd/{fd}"))
            .is_ok_and(|meta| !meta.file_type().is_socket())
        {
            std::process::exit(4);
        }
    }
    // SAFETY: owned single-threaded fixture retains only non-socket stdio.
    if unsafe { syscall(436, 3_usize, usize::MAX, 0_usize) } != 0 {
        std::process::exit(4);
    }
    let keys: Vec<_> = std::env::vars_os().map(|(key, _)| key).collect();
    for key in keys {
        // SAFETY: before any threads, runtime, backend or auth (there is no auth mode).
        unsafe {
            std::env::remove_var(key);
        }
    }
    if helper::serve(&mut std::io::stdin().lock(), &mut std::io::stdout().lock()).is_err() {
        std::process::exit(3);
    }
}
