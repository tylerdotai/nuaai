import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceProviderEvent } from '../src/voice/broker.js';
import { NativeVoiceTransport } from '../src/voice/native-transport.js';
import {
  NativeFrameDecoder,
  createNativeChildWire,
  encodeNativeFrame,
} from '../src/voice/native-wire.js';
import { voiceLimits } from '../src/voice/types.js';

function raw(json: string | Buffer) {
  const body = Buffer.isBuffer(json) ? json : Buffer.from(json);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

describe('private u32BE child framing', () => {
  it('decodes split headers, split Unicode, coalesced frames and exact boundary length', () => {
    const decoder = new NativeFrameDecoder();
    const events: unknown[] = [];
    const frames = Buffer.concat([
      raw('{"text":"é😀"}'),
      raw('{"v":1,"type":"hello","commandId":1}'),
    ]);
    for (const byte of frames) decoder.push(Buffer.from([byte]), (frame) => events.push(frame));
    decoder.end();
    expect(events).toEqual([{ text: 'é😀' }, { v: 1, type: 'hello', commandId: 1 }]);
    const boundary = raw(`{"x":"${'x'.repeat(voiceLimits.maxBodyBytes - 8)}"}`);
    expect(boundary.length).toBe(voiceLimits.maxBodyBytes + 4);
    new NativeFrameDecoder().push(boundary, () => {});
  });
  it.each([
    '{"v":1,"v":1}',
    '{"v":1,"\\u0076":1}',
    '{"x":1e999}',
    '{"x":"\\ud800"}',
    '{"x":"\\udc00"}',
    '{"x":null}',
    '{"x":true}',
    '{"x":{}}',
    '{"x":[]}',
    '{"x":01}',
    '{"x":1,}',
    '{"x":1} trailing',
    '[]',
    'null',
    '\ufeff{"x":1}',
  ])('rejects malformed flat JSON %s', (json) => {
    expect(() => new NativeFrameDecoder().push(raw(json), () => {})).toThrow(
      /VOICE_PROTOCOL_ERROR/,
    );
  });
  it('rejects invalid UTF-8, empty/oversized frames, partial headers/body and poisoned reuse', () => {
    expect(() => new NativeFrameDecoder().push(raw(Buffer.from([0xc0, 0xaf])), () => {})).toThrow(
      /VOICE_PROTOCOL_ERROR/,
    );
    for (const length of [0, voiceLimits.maxBodyBytes + 1, 0xffffffff]) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length);
      const decoder = new NativeFrameDecoder();
      expect(() => decoder.push(header, () => {})).toThrow(/VOICE_PAYLOAD_TOO_LARGE/);
      expect(() => decoder.push(raw('{"v":1}'), () => {})).toThrow(/VOICE_PROTOCOL_ERROR/);
    }
    for (const partial of [Buffer.from([0]), raw('{"v":1}').subarray(0, 6)]) {
      const decoder = new NativeFrameDecoder();
      decoder.push(partial, () => {});
      expect(() => decoder.end()).toThrow(/VOICE_PROTOCOL_ERROR/);
    }
    expect(() => encodeNativeFrame({ x: '\ud800' })).toThrow(/VOICE_PROTOCOL_ERROR/);
    expect(() => encodeNativeFrame({ x: Number.POSITIVE_INFINITY })).toThrow(
      /VOICE_PROTOCOL_ERROR/,
    );
    expect(() => encodeNativeFrame({ x: 'x'.repeat(voiceLimits.maxBodyBytes) })).toThrow(
      /VOICE_PAYLOAD_TOO_LARGE/,
    );
  });
  it('drains valid stdout when child exit occurs before stdio closure', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(),
    });
    const wire = createNativeChildWire(child as never);
    const seen: unknown[] = [];
    const failures: unknown[] = [];
    wire.subscribe(
      (value) => seen.push(value),
      (error) => failures.push(error),
    );
    const closed = { v: 1, type: 'closed', commandId: 3 };
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.stdout.end(encodeNativeFrame(closed));
    await immediate();
    await wire.close();
    expect(seen).toEqual([closed]);
    expect(failures).toHaveLength(1);
  });
  it('uses actual Node child stdio for offline handshake, handoffs, reverse results and bounded close', async () => {
    // Synthetic Node fixture only: no native helper/auth/provider/network calls.
    const script = `
let pending=Buffer.alloc(0);
const reply=(value)=>{const body=Buffer.from(JSON.stringify({v:1,...value}));const h=Buffer.alloc(4);h.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([h,body]));};
process.stdin.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=4&&pending.length>=4+pending.readUInt32BE()){
const n=pending.readUInt32BE();const m=JSON.parse(pending.subarray(4,4+n));pending=pending.subarray(4+n);
if(m.type==='hello')reply({type:'hello',commandId:m.commandId,profile:'offline-memory-v1',interruption:'unsupported'});
if(m.type==='start'){reply({type:'answer',commandId:m.commandId,sdp:'synthetic-answer'});setTimeout(()=>{reply({type:'control_ready',commandId:m.commandId});reply({type:'handoff',handoffId:'a',text:'task A'});reply({type:'handoff',handoffId:'b',text:'task B'});},10);}
if(m.type==='append')setTimeout(()=>reply({type:'delivery',commandId:m.commandId,handoffId:m.handoffId,deliveryId:m.deliveryId,status:'accepted'}),m.handoffId==='b'?15:1);
if(m.type==='close'){reply({type:'closed',commandId:m.commandId});process.stdin.destroy();process.stdout.end();}
}});
`;
    const child = spawn(process.execPath, ['-e', script], { env: {}, stdio: 'pipe' });
    const transport = new NativeVoiceTransport(createNativeChildWire(child));
    let handoffsReady!: () => void;
    const handoffs = new Promise<void>((resolve) => {
      handoffsReady = resolve;
    });
    const events: VoiceProviderEvent[] = [];
    try {
      expect(
        await transport.start(
          'synthetic-offer',
          (event) => {
            events.push(event);
            if (events.filter((item) => item.type === 'handoff').length === 2) handoffsReady();
          },
          new AbortController().signal,
        ),
      ).toBe('synthetic-answer');
      transport.acceptAnswer();
      await handoffs;
      await Promise.all([
        transport.deliver('B result', { handoffId: 'b', deliveryId: 'db' }),
        transport.deliver('A result', { handoffId: 'a', deliveryId: 'da' }),
      ]);
      await transport.stop();
      await transport.stop();
      expect(child.exitCode).toBe(0);
    } finally {
      await transport.stop();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
