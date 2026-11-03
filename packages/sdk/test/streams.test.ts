// `client.streams` over a fake WebSocket (design csi-c1 D12, camera-c1 D12): the hello carries `start` with a camera's
// fields, each binary message is parsed by the announced stream's kind (csi1 for csi, mjpg1 for jpeg) and handed to the
// handler with the stream, a message that does not parse is an `error` alone (gaps are the hub's drops), and stream.ended
// carries the jpeg bytes.

import { describe, expect, it } from 'vitest';

import { encodeCsiBlock, encodeJpegBlock, type JpegBlock, StreamClient, type StreamEvent } from '../src/index.ts';
import type { CsiBlock } from '../src/csi.ts';
import type { StreamHelloFrame, StreamInfo } from '../src/wire.ts';

class FakeWs {
  static last: FakeWs | null = null;
  readyState = 0;
  binaryType = '';
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }
  /** The hub's frames. */
  text(f: unknown): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  binary(b: Uint8Array): void {
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const JPEG = Uint8Array.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
const jpegInfo: StreamInfo = { stream_id: 7, kind: 'jpeg', format: 'mjpg1', to: 'hub', interval_ms: 100, frame_size: 'svga', quality: 12, seconds: 0 };
const csiInfo: StreamInfo = { stream_id: 8, kind: 'csi', format: 'csi1', source: 'router', seconds: 10 };
const rec = { tUs: 1, rssi: -40, noise: -90, channel: 1, bbFormat: 1, flags: 0, mac: 'aabbccddeeff', data: Int8Array.from([1, 2, 3, 4]) };

function client() {
  return new StreamClient({ url: 'ws://127.0.0.1:7420/app', token: () => 'tok', WebSocket: FakeWs as unknown as new (url: string) => unknown, reconnect: false });
}

describe('client.streams.subscribe, kind-aware (D12)', () => {
  it('sends the camera start in its hello, parses jpeg frames by the announced kind, reports bad bytes as an error (no gap), ended with bytes', async () => {
    const c = client();
    const blocks: { block: CsiBlock | JpegBlock; kind: string; streamId: number }[] = [];
    const events: StreamEvent[] = [];
    const off = c.subscribe('cam-esp32', 'cam', (block, bytes, stream) => blocks.push({ block, kind: stream.kind, streamId: stream.streamId }), {
      start: { intervalMs: 100, frameSize: 'svga', quality: 12 }, // the SDK's spelling; the hello carries the wire's
      onEvent: (e) => events.push(e),
    });
    await tick();
    const ws = FakeWs.last!;
    expect(ws.url).toBe('ws://127.0.0.1:7420/app/stream');
    expect(ws.binaryType).toBe('arraybuffer');
    const hello = JSON.parse(ws.sent[0]) as StreamHelloFrame;
    expect(hello).toEqual({ t: 'stream.hello', v: 1, token: 'tok', device: 'cam-esp32', instance: 'cam', start: { interval_ms: 100, frame_size: 'svga', quality: 12 } });
    // A binary message before any stream was announced is a protocol error, not a parse of some kind.
    ws.binary(encodeJpegBlock({ seq: 0, index: 0, tUs: 1, width: 800, height: 600, quality: 12, frameSize: 'svga' }, JPEG));
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'PROTOCOL', message: expect.stringContaining('before the hub announced') });
    ws.text({ t: 'stream.welcome', v: 1, device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', stream: jpegInfo });
    expect(events.at(-1)).toEqual({ type: 'welcome', device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', stream: { streamId: 7, kind: 'jpeg', format: 'mjpg1', to: 'hub', intervalMs: 100, frameSize: 'svga', quality: 12, seconds: 0 } });
    ws.binary(encodeJpegBlock({ seq: 0, index: 0, tUs: 1, width: 800, height: 600, quality: 12, frameSize: 'svga' }, JPEG));
    ws.binary(encodeJpegBlock({ seq: 1, index: 2, tUs: 2, width: 800, height: 600, quality: 12, frameSize: 'svga', flags: 1 }, JPEG));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'jpeg', streamId: 7, block: { seq: 0, index: 0, width: 800, height: 600, frameSize: 'svga', flags: 0 } });
    expect([...(blocks[1].block as JpegBlock).jpeg]).toEqual([...JPEG]);
    expect((blocks[1].block as JpegBlock).flags).toBe(1);
    // Bytes that are not an mjpg1 frame: the error path alone (a `gap` is the hub's drop of a block to a slow socket).
    const n = events.length;
    ws.binary(Uint8Array.from([1, 2, 3]));
    expect(events.slice(n)).toEqual([{ type: 'error', code: 'PROTOCOL', message: expect.stringContaining('not an mjpg1 frame') }]);
    expect(blocks).toHaveLength(2);
    ws.text({ t: 'stream.ended', stream_id: 7, reason: 'done', records: 2, dropped: 1, bytes: 14 });
    expect(events.at(-1)).toEqual({ type: 'ended', streamId: 7, reason: 'done', records: 2, dropped: 1, bytes: 14 });
    // The next stream on the instance is a csi one: its blocks parse as csi1.
    ws.text({ t: 'stream.started', stream: csiInfo });
    expect(events.at(-1)).toEqual({ type: 'started', stream: { streamId: 8, kind: 'csi', format: 'csi1', source: 'router', seconds: 10 } });
    ws.binary(encodeCsiBlock(0, 0, [rec]));
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toMatchObject({ kind: 'csi', streamId: 8, block: { seq: 0, firstIndex: 0 } });
    expect((blocks[2].block as CsiBlock).records).toHaveLength(1);
    ws.text({ t: 'stream.ended', stream_id: 8, reason: 'stopped', records: 1, dropped: 0 });
    expect(events.at(-1)).toEqual({ type: 'ended', streamId: 8, reason: 'stopped', records: 1, dropped: 0 });
    off();
    expect(ws.closed).toEqual({ code: 1000, reason: 'unsubscribed' });
  });

  it('a csi hello carries source and peer; without start, none', async () => {
    const c = client();
    c.subscribe('csi-c5', undefined, () => undefined, { start: { source: 'peer', peer: 'tx-pad' } });
    await tick();
    expect(JSON.parse(FakeWs.last!.sent[0])).toEqual({ t: 'stream.hello', v: 1, token: 'tok', device: 'csi-c5', start: { source: 'peer', peer: 'tx-pad' } });
    c.subscribe('csi-c5', 'csi', () => undefined);
    await tick();
    expect(JSON.parse(FakeWs.last!.sent[0])).toEqual({ t: 'stream.hello', v: 1, token: 'tok', device: 'csi-c5', instance: 'csi' });
    // The wire's spellings are taken as given.
    c.subscribe('cam-esp32', undefined, () => undefined, { start: { interval_ms: 0, frame_size: 'xga' } });
    await tick();
    expect(JSON.parse(FakeWs.last!.sent[0])).toEqual({ t: 'stream.hello', v: 1, token: 'tok', device: 'cam-esp32', start: { interval_ms: 0, frame_size: 'xga' } });
    c.closeAll();
  });
});
