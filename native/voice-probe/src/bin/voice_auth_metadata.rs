//! Private reviewed one-shot native read-only auth metadata. No provider request.
// Reuse the exact helper argument/environment/descriptor guard, not a relaxed entry.
#[allow(dead_code)]
#[path = "subscription_voice.rs"]
mod entry;
fn main() {
    let Ok(home) = entry::prepare() else {
        std::process::exit(2);
    };
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    else {
        std::process::exit(3);
    };
    let metadata = runtime.block_on(nuaai_voice_probe::subscription_voice::auth_metadata(home));
    runtime.shutdown_timeout(std::time::Duration::from_millis(50));
    println!("{metadata}"); // fixed booleans/stages/timings only, never a native error Debug value
}
