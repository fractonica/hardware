// A real hub process for the cross-stream interop suites (design c6 §7c): packages/hub/src/main.ts as `fr hub
// start` runs it, but on ephemeral loopback ports, without USB ports (or with a virtual USB hub's, `serialBridge`,
// m2-c1-hil §5.1) or the mDNS advert, and with FR_HOME and TMPDIR in a temp dir. From M2-C2 (design m2-c2 D9) the
// module lives in tests/sim/lib/private-hub.ts, which the sim runner shares; this file re-exports it, so its API and
// its callers do not change.

export { type RealHub, type RealHubDevice, startRealHub } from '../../../tests/sim/lib/private-hub.ts';
