// FNV-1a 32 and the hashes HELLO carries (design c3 §2, spec 05 §5.7): descriptor_hash over the encoded
// Descriptor (what fr.node.describe returns), board_hash over the board id. The C++ twin is fr/hash.hpp;
// catalog_hash (packages/codegen) is FNV-1a 32 too, over the canonical catalog JSON.

const utf8 = new TextEncoder();

/** FNV-1a 32 over bytes, or over the UTF-8 bytes of a string. */
export function fnv1a32(data: string | Uint8Array): number {
  const bytes = typeof data === 'string' ? utf8.encode(data) : data;
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** HELLO `descriptor_hash`: FNV-1a 32 over the protobuf-wire Descriptor bytes. */
export function descriptorHash(descriptor: Uint8Array): number {
  return fnv1a32(descriptor);
}

/** HELLO `board_hash`: FNV-1a 32 over the board id (`esp32c6-supermini`). */
export function boardHash(board: string): number {
  return fnv1a32(board);
}
