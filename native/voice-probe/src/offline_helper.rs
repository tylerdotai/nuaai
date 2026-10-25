//! Functional private helper-u32be-v1 codec and inert memory backend.
//! No auth, network, provider URLs, executor, runtime or live mode.
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{Read, Write};

pub const MAX_FRAME: usize = 131_072;
const MAX_SDP: usize = 98_304;
const MAX_TEXT: usize = 16_384;
const MAX_DELIVERIES: usize = 256;
const ANSWER: &str = "v=0\r\na=offline-memory-v1\r\n";
const HANDOFFS: [&str; 2] = ["offline-handoff-A", "offline-handoff-B"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Protocol,
    Payload,
    Io,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Protocol => "VOICE_PROTOCOL_ERROR",
            Self::Payload => "VOICE_PAYLOAD_TOO_LARGE",
            Self::Io => "VOICE_PROVIDER_ERROR",
        }
    }
}

// serde_json::Value alone loses duplicate keys. Check decoded top-level keys too,
// including escaped-equivalent names; all permitted frames are flat objects.
fn unique_flat_keys(bytes: &[u8]) -> Result<(), Error> {
    let mut keys = HashSet::new();
    let mut depth = 0;
    let mut want_key = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => {
                depth += 1;
                if depth > 1 {
                    return Err(Error::Protocol);
                }
                want_key = true;
            }
            b'}' | b']' => depth -= 1,
            b',' if depth == 1 => want_key = true,
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == b'"' {
                        break;
                    }
                    i += 1;
                }
                if i >= bytes.len() {
                    return Err(Error::Protocol);
                }
                if want_key && depth == 1 {
                    let key: String =
                        serde_json::from_slice(&bytes[start..=i]).map_err(|_| Error::Protocol)?;
                    if !keys.insert(key) {
                        return Err(Error::Protocol);
                    }
                    want_key = false;
                }
            }
            _ => {}
        }
        i += 1;
    }
    Ok(())
}

pub fn read_frame(input: &mut impl Read) -> Result<Option<Value>, Error> {
    let mut prefix = [0; 4];
    match input.read(&mut prefix[..1]).map_err(|_| Error::Io)? {
        0 => return Ok(None),
        _ => input
            .read_exact(&mut prefix[1..])
            .map_err(|_| Error::Protocol)?,
    }
    let len = u32::from_be_bytes(prefix) as usize;
    if len == 0 {
        return Err(Error::Protocol);
    }
    if len > MAX_FRAME {
        return Err(Error::Payload);
    }
    let mut bytes = vec![0; len];
    input.read_exact(&mut bytes).map_err(|_| Error::Protocol)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Protocol)?;
    if !value.is_object() {
        return Err(Error::Protocol);
    }
    unique_flat_keys(&bytes)?;
    Ok(Some(value))
}

pub fn write_frame(output: &mut impl Write, value: &Value) -> Result<(), Error> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Protocol)?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(Error::Payload);
    }
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|_| Error::Io)?;
    output.write_all(&bytes).map_err(|_| Error::Io)?;
    output.flush().map_err(|_| Error::Io)
}

fn exact(value: &Value, fields: &[&str]) -> Result<(), Error> {
    let object = value.as_object().ok_or(Error::Protocol)?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err(Error::Protocol);
    }
    Ok(())
}
fn text<'a>(value: &'a Value, field: &str, max: usize) -> Result<&'a str, Error> {
    let text = value[field].as_str().ok_or(Error::Protocol)?;
    if text.is_empty() || text.len() > max {
        return Err(Error::Payload);
    }
    Ok(text)
}
pub fn command_id(value: &Value) -> Option<u64> {
    value["commandId"]
        .as_u64()
        .filter(|id| (1..=2_147_483_647).contains(id))
}

#[derive(Default)]
struct MemoryBackend {
    closed: bool,
    close_count: usize,
    deliveries: Vec<(String, String, Vec<String>)>,
}
impl MemoryBackend {
    fn append(&mut self, handoff: &str, delivery: &str, text: &str) -> Result<(), Error> {
        if self.closed
            || !HANDOFFS.contains(&handoff)
            || self.deliveries.len() >= MAX_DELIVERIES
            || self.deliveries.iter().any(|(_, id, _)| id == delivery)
        {
            return Err(Error::Protocol);
        }
        let mut chunks = Vec::new();
        let mut chunk = String::new();
        for ch in text.chars() {
            if chunk.len() + ch.len_utf8() > 500 {
                chunks.push(std::mem::take(&mut chunk));
            }
            chunk.push(ch);
        }
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        self.deliveries
            .push((handoff.into(), delivery.into(), chunks));
        Ok(())
    }
    fn close(&mut self) {
        if !self.closed {
            self.closed = true;
            self.close_count += 1;
        }
    }
}

#[derive(Default)]
pub struct Session {
    last_id: u64,
    hello: bool,
    ready: bool,
    pub closed: bool,
    backend: MemoryBackend,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.finish();
    }
}
impl Session {
    pub fn finish(&mut self) {
        self.backend.close();
        self.closed = true;
    }
    pub fn handle(&mut self, value: &Value) -> Result<Vec<Value>, Error> {
        if self.closed || value["v"] != 1 {
            return Err(Error::Protocol);
        }
        let id = command_id(value).ok_or(Error::Protocol)?;
        if id <= self.last_id {
            return Err(Error::Protocol);
        }
        let kind = value["type"].as_str().ok_or(Error::Protocol)?;
        let events = match kind {
            "hello" => {
                exact(value, &["v", "type", "commandId"])?;
                if self.hello {
                    return Err(Error::Protocol);
                }
                self.hello = true;
                vec![
                    json!({"v":1,"type":"hello","commandId":id,"profile":"offline-memory-v1","interruption":"unsupported"}),
                ]
            }
            "start" => {
                exact(value, &["v", "type", "commandId", "offer"])?;
                if !self.hello || self.ready {
                    return Err(Error::Protocol);
                }
                text(value, "offer", MAX_SDP)?;
                self.ready = true;
                vec![
                    json!({"v":1,"type":"answer","commandId":id,"sdp":ANSWER}),
                    json!({"v":1,"type":"control_ready","commandId":id}),
                    json!({"v":1,"type":"handoff","handoffId":HANDOFFS[0],"text":"Synthetic offline task A"}),
                    json!({"v":1,"type":"handoff","handoffId":HANDOFFS[1],"text":"Synthetic offline task B"}),
                ]
            }
            "append" => {
                exact(
                    value,
                    &["v", "type", "commandId", "handoffId", "deliveryId", "text"],
                )?;
                if !self.ready {
                    return Err(Error::Protocol);
                }
                let handoff = text(value, "handoffId", 256)?;
                let delivery = text(value, "deliveryId", 256)?;
                self.backend
                    .append(handoff, delivery, text(value, "text", MAX_TEXT)?)?;
                vec![
                    json!({"v":1,"type":"delivery","commandId":id,"handoffId":handoff,"deliveryId":delivery,"status":"accepted"}),
                ]
            }
            "close" => {
                exact(value, &["v", "type", "commandId"])?;
                self.finish();
                vec![json!({"v":1,"type":"closed","commandId":id})]
            }
            _ => return Err(Error::Protocol),
        };
        self.last_id = id;
        Ok(events)
    }
}

pub fn serve(input: &mut impl Read, output: &mut impl Write) -> Result<(), Error> {
    let mut session = Session::default();
    loop {
        let frame = match read_frame(input) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                session.finish();
                return Ok(());
            }
            Err(error) => {
                let _ = write_frame(output, &json!({"v":1,"type":"error","code":error.code()}));
                return Err(error);
            }
        };
        match session.handle(&frame) {
            Ok(events) => {
                for event in events {
                    write_frame(output, &event)?;
                }
                if session.closed {
                    return Ok(());
                }
            }
            Err(error) => {
                let mut event = json!({"v":1,"type":"error","code":error.code()});
                if let Some(id) = command_id(&frame) {
                    event["commandId"] = json!(id);
                }
                let _ = write_frame(output, &event);
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn frames(values: &[Value]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for value in values {
            write_frame(&mut bytes, value).unwrap();
        }
        bytes
    }
    fn raw(bytes: &[u8]) -> Vec<u8> {
        let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(bytes);
        frame
    }
    fn hello() -> Value {
        json!({"v":1,"type":"hello","commandId":1})
    }
    fn start() -> Value {
        json!({"v":1,"type":"start","commandId":2,"offer":"v=0\r\n"})
    }
    fn append(id: u64, handoff: &str, delivery: &str, text: &str) -> Value {
        json!({"v":1,"type":"append","commandId":id,"handoffId":handoff,"deliveryId":delivery,"text":text})
    }

    #[test]
    fn hello_then_answer_before_ready_and_real_memory_delivery() {
        let mut session = Session::default();
        let reply = session.handle(&hello()).unwrap();
        assert_eq!(reply[0]["profile"], "offline-memory-v1");
        let events = session.handle(&start()).unwrap();
        assert_eq!(events[0]["type"], "answer");
        assert_eq!(events[1]["type"], "control_ready");
        assert_eq!(events[2]["handoffId"], HANDOFFS[0]);
        assert_eq!(events[3]["handoffId"], HANDOFFS[1]);
        let ack = session
            .handle(&append(3, HANDOFFS[1], "delivery-B", "result B"))
            .unwrap();
        assert_eq!(ack[0]["handoffId"], HANDOFFS[1]);
        assert_eq!(ack[0]["deliveryId"], "delivery-B");
        assert_eq!(ack[0]["status"], "accepted");
        let ack = session
            .handle(&append(4, HANDOFFS[0], "delivery-A", "result A"))
            .unwrap();
        assert_eq!(ack[0]["handoffId"], HANDOFFS[0]);
        assert_eq!(session.backend.deliveries.len(), 2);
    }
    #[test]
    fn prefix_bounds_truncation_utf8_duplicates_and_nested_values_reject() {
        for bytes in [
            vec![0, 0],
            vec![0, 0, 0, 0],
            (MAX_FRAME as u32 + 1).to_be_bytes().to_vec(),
            raw(b"{\"v\":1,\"v\":1}"),
            raw(br#"{"v":1,"\u0076":1}"#),
            raw(b"{\"v\":1,\"extra\":{}}"),
            raw(&[0xff]),
            raw(br#"{"x":"\ud800"}"#),
        ] {
            assert!(read_frame(&mut Cursor::new(bytes)).is_err());
        }
        let mut truncated = frames(&[hello()]);
        truncated.pop();
        assert!(read_frame(&mut Cursor::new(truncated)).is_err());
        assert!(
            read_frame(&mut Cursor::new(Vec::<u8>::new()))
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn codec_handles_concatenated_and_single_byte_reads() {
        struct ByteReader(Cursor<Vec<u8>>);
        impl Read for ByteReader {
            fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
                let cap = target.len().min(1);
                self.0.read(&mut target[..cap])
            }
        }
        let mut input = ByteReader(Cursor::new(frames(&[hello(), start()])));
        assert_eq!(read_frame(&mut input).unwrap(), Some(hello()));
        assert_eq!(read_frame(&mut input).unwrap(), Some(start()));
        assert!(read_frame(&mut input).unwrap().is_none());
    }
    #[test]
    fn chunking_keeps_exact_unicode_and_closes_once() {
        let mut backend = MemoryBackend::default();
        let text = "😀漢a".repeat(200);
        backend.append(HANDOFFS[0], "d", &text).unwrap();
        let chunks = &backend.deliveries[0].2;
        assert!(
            chunks
                .iter()
                .all(|chunk| !chunk.is_empty() && chunk.len() <= 500)
        );
        assert_eq!(chunks.concat(), text);
        backend.close();
        backend.close();
        assert_eq!(backend.close_count, 1);
        assert!(backend.append(HANDOFFS[0], "e", "x").is_err());
    }
    #[test]
    fn state_version_unknown_fields_and_command_replay_fail_closed() {
        for command in [
            start(),
            append(2, HANDOFFS[0], "d", "x"),
            json!({"v":2,"type":"hello","commandId":1}),
            json!({"v":1,"type":"hello","commandId":0}),
            json!({"v":1,"type":"hello","commandId":2147483648_u64}),
            json!({"v":1,"type":"hello","commandId":1,"url":"forbidden"}),
        ] {
            assert!(Session::default().handle(&command).is_err());
        }
        let mut session = Session::default();
        session.handle(&hello()).unwrap();
        assert!(session.handle(&hello()).is_err());
        session.handle(&start()).unwrap();
        session.handle(&append(3, HANDOFFS[0], "d", "x")).unwrap();
        assert!(session.handle(&append(4, HANDOFFS[1], "d", "x")).is_err());
        assert!(session.handle(&append(4, "unknown", "e", "x")).is_err());
        session.finish();
        session.finish();
        assert_eq!(session.backend.close_count, 1);
    }
    #[test]
    fn semantic_byte_limits_and_backend_memory_are_bounded() {
        let mut session = Session::default();
        session.handle(&hello()).unwrap();
        assert_eq!(
            session
                .handle(&json!({"v":1,"type":"start","commandId":2,"offer":"a".repeat(MAX_SDP+1)})),
            Err(Error::Payload)
        );
        session.handle(&start()).unwrap();
        assert_eq!(
            session.handle(&append(3, HANDOFFS[0], "d", &"😀".repeat(MAX_TEXT / 4 + 1))),
            Err(Error::Payload)
        );
        assert_eq!(
            session.handle(&append(3, HANDOFFS[0], &"x".repeat(257), "x")),
            Err(Error::Payload)
        );
        let mut backend = MemoryBackend::default();
        for index in 0..MAX_DELIVERIES {
            backend
                .append(HANDOFFS[0], &index.to_string(), "x")
                .unwrap();
        }
        assert!(backend.append(HANDOFFS[0], "overflow", "x").is_err());
    }
    #[test]
    fn full_stdio_framing_path_stops_once_after_close_and_handles_eof() {
        let commands = [
            hello(),
            start(),
            append(3, HANDOFFS[1], "b", "result B"),
            append(4, HANDOFFS[0], "a", "result A"),
            json!({"v":1,"type":"close","commandId":5}),
        ];
        let mut output = Vec::new();
        serve(&mut Cursor::new(frames(&commands)), &mut output).unwrap();
        let mut stream = Cursor::new(output);
        let mut events = Vec::new();
        while let Some(frame) = read_frame(&mut stream).unwrap() {
            events.push(frame);
        }
        assert_eq!(events.len(), 8);
        assert_eq!(events[1]["type"], "answer");
        assert_eq!(events[2]["type"], "control_ready");
        assert_eq!(events[5]["deliveryId"], "b");
        assert_eq!(events[6]["deliveryId"], "a");
        assert_eq!(events[7]["type"], "closed");
        let mut output = Vec::new();
        serve(&mut Cursor::new(frames(&[hello(), start()])), &mut output).unwrap();
        let mut stream = Cursor::new(output);
        let mut count = 0;
        while read_frame(&mut stream).unwrap().is_some() {
            count += 1;
        }
        assert_eq!(count, 5);
    }
    #[test]
    fn eof_closes_without_output_and_errors_are_sanitized() {
        let mut output = Vec::new();
        assert_eq!(
            serve(&mut Cursor::new(Vec::<u8>::new()), &mut output),
            Ok(())
        );
        assert!(output.is_empty());
        let error = serve(
            &mut Cursor::new(raw(b"not JSON private raw bytes")),
            &mut output,
        );
        assert!(error.is_err());
        let event = read_frame(&mut Cursor::new(output)).unwrap().unwrap();
        assert_eq!(
            event,
            json!({"v":1,"type":"error","code":"VOICE_PROTOCOL_ERROR"})
        );
    }
}
