fn main() {
    nuaai_voice_probe::check_public_symbols();
    println!(
        "nuaai-voice-probe protocol={} upstream={} compile-only; no auth or transport",
        nuaai_voice_probe::PROBE_PROTOCOL,
        nuaai_voice_probe::UPSTREAM_COMMIT,
    );
}
