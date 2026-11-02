// The node's persistent node <-> node tables (design c5 §3; spec 05 §5.10, 07 §7.11): the directory
// (addr -> MAC, from NET/DIRECTORY) and the bindings (fr.node.bind_set). Net keeps both in fixed arrays on
// the core task and persists them through the store interfaces below, so the core stays IDF-free: fr_core
// implements them over NVS (`nvs:fr_dir`, `nvs:fr_bind`), writing on fr_worker, and the host tests in memory.
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/net/air.hpp"
#include "fr/net/limits.hpp"
#include "messages.hpp"  // generated fr::proto::Binding (kMaxSize)

namespace fr::net {

/** FR_DIRECTORY_MAX: directory entries a node keeps (05 §5.17; 64, or the memory class's); RESOLVE beyond that. */
inline constexpr size_t kDirectoryMax = limits::kDirectory;
/** FR_BINDINGS_MAX: binding slots per node (07 §7.11); a Binding's slot is 0..15. */
inline constexpr size_t kBindingsMax = 16;
/** fr.node.bind_clear `slot` that clears every slot. */
inline constexpr uint8_t kBindSlotAll = 255;
/** fr.node.bind_list's `bindings` holds at most this (node.cap.yaml: what a bulk RESULT leaves), so the whole
 * table, encoded as a BindingList, is kept within it. */
inline constexpr size_t kBindListMax = 1400;

/** addr -> MAC (the device_id), as NET/DIRECTORY pages give them. */
struct DirEntry {
    uint16_t addr = 0;
    Mac mac{};
};

/** The directory: `count` entries, unordered. */
struct Directory {
    std::array<DirEntry, kDirectoryMax> entries{};
    size_t count = 0;

    const DirEntry *find(uint16_t addr) const
    {
        const auto end = entries.begin() + static_cast<std::ptrdiff_t>(std::min(count, kDirectoryMax));
        const auto it = std::find_if(entries.begin(), end, [addr](const DirEntry &e) { return e.addr == addr; });
        return it == end ? nullptr : &*it;
    }
};

/**
 * One binding slot: the encoded Binding as fr.node.bind_set brought it (its args are a Binding, design c5
 * §2). Kept encoded so the table owns its bytes; decode_binding() gives views into them when it fires.
 */
struct BindingSlot {
    bool used = false;
    uint8_t len = 0;
    uint8_t bytes[fr::proto::Binding::kMaxSize] = {};

    std::span<const uint8_t> encoded() const { return {bytes, used ? len : size_t{0}}; }
};

/** Every slot, indexed by Binding::slot. */
using BindingTable = std::array<BindingSlot, kBindingsMax>;

/** Persistence of the directory (`nvs:fr_dir`). Called on the core task. */
class DirectoryStore
{
public:
    /** The stored directory, at boot; false (and `out` untouched) when there is none or it does not read. */
    virtual bool load(Directory &out) = 0;
    /** Keeps `d` for the next boot. Must not block the core task: the node copies it and writes on fr_worker. */
    virtual void save(const Directory &d) = 0;

protected:
    ~DirectoryStore() = default;
};

/** Persistence of the bindings (`nvs:fr_bind`). Called on the core task. */
class BindingStore
{
public:
    /** The stored table, at boot; false (and `out` untouched) when there is none or it does not read. */
    virtual bool load(BindingTable &out) = 0;
    /** Keeps `t` for the next boot. Must not block the core task: the node copies it and writes on fr_worker. */
    virtual void save(const BindingTable &t) = 0;

protected:
    ~BindingStore() = default;
};

}  // namespace fr::net
