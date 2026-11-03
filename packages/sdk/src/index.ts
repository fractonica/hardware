// @fractonica/sdk (spec 07 §7.9, design c6 §4): the typed browser and Node client of the hub's `/app`
// endpoint (`fr-app/1`). Zero runtime dependencies, so it runs unbundled in Node (>= 22.4, global WebSocket)
// and bundled in hosted apps.
//
//   import { connect } from '@fractonica/sdk';
//   import { devices } from './fractonica/devices.ts';          // fr codegen client --out ./fractonica
//   const hub = await connect({ registry: devices });            // the token: injected, or token.ts
//   const pad = hub.devices.byAlias('pad-c6');                   // typed from devices.ts
//   pad.on('boot.down', (e) => console.log(e.tHubUs, e.late));
//   await pad.status.blink({ count: 1 });

import { HubClient } from './hub.ts';
import type { ConnectOptions, Hub, Registry } from './types.ts';

/**
 * Connects to the hub's `/app` and resolves on its welcome, with every provisioned device's presence and
 * property mirror; then reconnects by itself (backoff) until hub.close(). Rejects with FractonicaError:
 * HUB_UNREACHABLE (no welcome within connectTimeoutMs), UNAUTHORIZED (a bad token), VERSION_MISMATCH.
 */
export async function connect<R extends Registry = Registry>(opts: ConnectOptions<R> = {}): Promise<Hub<R>> {
  const hub = new HubClient(opts as ConnectOptions<Registry>);
  await hub.start();
  return hub as unknown as Hub<R>;
}

export { CAP_META, CATALOG_HASH } from './gen/caps.ts';
export type * from './gen/caps.ts';
export { camel, snake } from './case.ts';
export { CommandError, FractonicaError, type FractonicaErrorCode } from './errors.ts';
export { DEFAULT_URL } from './hub.ts';
export {
  CSI_FILE_HEAD_BYTES,
  CSI_FILE_MAGIC,
  CSI_FILE_VERSION,
  csiAmplitudes,
  csiFileHead,
  csiFileRecord,
  csiPhases,
  encodeCsiBlock,
  encodeCsiFile,
  parseCsiBlock,
  parseCsiFile,
  CsiParseError,
  type CsiBlock,
  type CsiRecord,
} from './csi.ts';
export { encodeJpegBlock, parseJpegBlock, JpegParseError, type JpegBlock } from './camera.ts';
export { StreamClient, streamUrl, wireStart, type StreamBlockHandler, type StreamDescription, type StreamEvent, type Streams, type StreamSource, type StreamStartOptions, type StreamSubscribeOptions } from './streams.ts';
export type {
  AnyDevice,
  AnyEvent,
  BroadcastResult,
  CallOptions,
  CmdResult,
  ConnectOptions,
  Device,
  DeviceEvent,
  Devices,
  EventPayload,
  EventType,
  Hub,
  HubEventMap,
  HubMsg,
  HubStats,
  Instance,
  InstanceInfo,
  InstanceMap,
  MsgResult,
  RawDevice,
  ReconnectOptions,
  Registry,
  RegistryDevice,
  RegistryDrift,
  Sent,
  StateChange,
  SystemInstances,
} from './types.ts';
