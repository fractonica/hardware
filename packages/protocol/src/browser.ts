// `@fractonica/protocol/browser` (design c6 §3.2): the part of the protocol a browser bundle may load,
// with no Node builtin anywhere in its imports (the dashboard build fails on one; a test walks them).
// It has the op registry and its types, results and error codes, cursors, hub events, the `/ws` frames
// (fr-ws/1) and the alias rules. The root entry adds REGISTRY_HASH (node:crypto) and the wire runtime;
// generated code stays on `/gen`.

export * from './bench.ts';
export * from './cursor.ts';
export * from './events.ts';
export * from './names.ts';
export * from './ops.ts';
export * from './result.ts';
export * from './types.ts';
export * from './ws.ts';
