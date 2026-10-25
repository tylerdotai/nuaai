// Independent, std-only Linux/x86_64 fixture for validating the approved strace fence.
// NOT an auth-policy test. All calls deliberately use no remote endpoint or invalid FDs.
// Never invoke any provider/auth library here. No Cargo manifest or dependencies required.
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("This syscall canary is Linux/x86_64 only");

use std::fs;
use std::io;
use std::os::unix::fs::FileTypeExt;
use std::process::Command;

unsafe extern "C" {
    fn syscall(number: i64, ...) -> i64;
    fn close(fd: i32) -> i32;
}

fn isolated_descriptors() {
    for fd in 0..=2 {
        let metadata =
            fs::metadata(format!("/proc/self/fd/{fd}")).expect("stdio metadata unavailable");
        assert!(
            !metadata.file_type().is_socket(),
            "stdio must not inherit sockets"
        );
    }
    // Linux close_range(3, UINT_MAX, 0): leave only stdio in this owned child.
    let result = unsafe { syscall(436, 3_usize, usize::MAX, 0_usize) };
    assert_eq!(result, 0, "cannot establish explicit descriptor isolation");
}

fn expect_injected(result: i64, label: &str) {
    if result >= 0 {
        // The only potentially positive result is an unconnected socket; close it immediately.
        if label == "socket" {
            unsafe { close(result as i32) };
        }
        panic!("fence did not deny {label}");
    }
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(1),
        "expected injected EPERM for {label}"
    );
}

fn exercise_fence() {
    // If injection is broken, this creates only an unconnected socket, closed above.
    expect_injected(unsafe { syscall(41, 2_usize, 1_usize, 0_usize) }, "socket");
    // Invalid descriptors/null arguments ensure these have no remote effect even if injection fails.
    expect_injected(
        unsafe { syscall(42, -1_isize, 0_usize, 0_usize) },
        "connect",
    );
    expect_injected(
        unsafe { syscall(44, -1_isize, 0_usize, 0_usize, 0_usize, 0_usize, 0_usize) },
        "sendto",
    );
    expect_injected(
        unsafe { syscall(46, -1_isize, 0_usize, 0_usize) },
        "sendmsg",
    );
    expect_injected(
        unsafe { syscall(307, -1_isize, 0_usize, 0_usize, 0_usize) },
        "sendmmsg",
    );
    expect_injected(unsafe { syscall(425, 0_usize, 0_usize) }, "io_uring_setup");
    expect_injected(
        unsafe { syscall(426, -1_isize, 0_usize, 0_usize, 0_usize, 0_usize, 0_usize) },
        "io_uring_enter",
    );
    expect_injected(
        unsafe { syscall(427, -1_isize, 0_usize, 0_usize, 0_usize) },
        "io_uring_register",
    );
}

fn main() {
    isolated_descriptors();
    exercise_fence();
    if std::env::args().nth(1).as_deref() == Some("--child") {
        println!("CANARY_CHILD_EXPECTED_INJECTION_OK");
        return;
    }
    let home = std::env::var_os("CANARY_SYNTHETIC_HOME").expect("explicit synthetic home required");
    let status = Command::new(std::env::current_exe().expect("canary executable unavailable"))
        .arg("--child")
        .env_clear()
        .env("HOME", &home)
        .env("CODEX_HOME", &home)
        .env("CANARY_SYNTHETIC_HOME", &home)
        .status()
        .expect("owned canary child failed to launch");
    assert!(
        status.success(),
        "descendant did not inherit syscall injection"
    );
    println!("CANARY_PARENT_EXPECTED_INJECTION_OK processes=2 attempts=16");
}
