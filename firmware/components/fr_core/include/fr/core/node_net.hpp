// What fr_core adds around fr_net's Net for C5 (design c5 §3, §6 N2; spec 07 §7.11), IDF-free so the
// host suite and fr_net_node run the same code as the target:
//   - fr.node bind_set / bind_clear / bind_list on Net's binding table;
//   - the MSG handler table behind fr::msg::on and Host::msg, and the MSG frame behind fr::msg::send;
//   - the persistence of the directory (nvs:fr_dir) and the bindings (nvs:fr_bind): net::DirectoryStore and
//     net::BindingStore over a Blob (one NVS key on target, a file or memory on the host), written on
//     fr_worker so the core task never waits for flash.
// It includes fr_net's Net, so only code that sees fr_net includes it: fr_core's sources, the host suite.
#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <span>
#include <string_view>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/core/worker.hpp"
#include "fr/hash.hpp"
#include "fr/msg.hpp"
#include "fr/net/net.hpp"
#include "fr/net/stores.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"  // generated fr::proto::Binding, MsgMsg
#include "node.hpp"      // generated fr::cap::NodeBindSetArgs, NodeBindClearArgs, NodeBindListResult

namespace fr::core {

// ---- fr.node bindings (07 §7.11) ----

/** bind_list's `bindings` field holds at most this (node.cap.yaml), the room a bulk RESULT leaves; Net's
 * set_binding keeps the table within the same limit. */
inline constexpr size_t kBindListMax = net::kBindListMax;
static_assert(cap::NodeBindListResult::kMaxSize == 1 + 2 + kBindListMax,  // tag, 2-byte length, the bytes
              "node.cap.yaml bind_list.bindings max differs from fr::net::kBindListMax");

/** bind_set's args are a Binding's fields under the same ids (design c5 §2). */
inline proto::Binding to_binding(const cap::NodeBindSetArgs &a)
{
    proto::Binding b;
    b.slot = a.slot;
    b.on_port = a.on_port;
    b.on_cls = a.on_cls;
    b.on_kind = a.on_kind;
    b.on_topic = a.on_topic;
    b.to_mac = a.to_mac;
    b.to_addr = a.to_addr;
    b.to_port = a.to_port;
    b.to_cls = a.to_cls;
    b.to_kind = a.to_kind;
    b.to_topic = a.to_topic;
    b.payload = a.payload;
    b.reliable = a.reliable;
    return b;
}

/** fr.node.bind_set: the args re-encoded as a Binding into Net's table (and its store). */
inline Status bind_set(net::Net &net, const cap::NodeBindSetArgs &args)
{
    uint8_t buf[proto::Binding::kMaxSize];
    wire::Writer w(buf, sizeof(buf));
    proto::encode(to_binding(args), w);
    if (w.overflow()) {
        return std::unexpected(Err::invalid_args);  // cannot happen: the generated decoder kept the limits
    }
    return net.set_binding(w.bytes());
}

inline Status bind_clear(net::Net &net, const cap::NodeBindClearArgs &args)
{
    return net.clear_binding(args.slot);
}

/** fr.node.bind_list: the encoded BindingList in `buf` (kBindListMax), which the result points into. */
inline std::expected<cap::NodeBindListResult, Err> bind_list(const net::Net &net, std::span<uint8_t> buf)
{
    auto bytes = net.encode_bindings(buf.first(std::min(buf.size(), kBindListMax)));
    if (!bytes) {
        return std::unexpected(bytes.error());
    }
    return cap::NodeBindListResult{.bindings = *bytes};
}

// ---- MSG (fr::msg) ----

/**
 * fr::msg::send on `net`: MSG.MSG {topic, data} through Net::send_msg, to another node, kBroadcast, the hub
 * (kHub: apps get a `msg` event) or this node itself (its own bindings and handlers). The topic must be
 * non-empty UTF-8 (the hub decodes it as text); Net checks the rest. Core task.
 */
inline Status msg_send(net::Net &net, uint16_t dst, std::string_view topic, std::span<const uint8_t> data,
                       bool reliable)
{
    if (topic.empty() || topic.size() > msg::kTopicMax || data.size() > msg::kDataMax ||
        !wire::utf8_valid({reinterpret_cast<const uint8_t *>(topic.data()), topic.size()})) {
        return std::unexpected(Err::invalid_args);
    }
    return net.send_msg(dst, topic, data, reliable ? net::Delivery::reliable : net::Delivery::fast);
}

/** The fr::msg::on table, which Host::msg dispatches into. Core task. */
class MsgHandlers
{
public:
    Status add(std::string_view topic, msg::Handler handler)
    {
        if (topic.empty() || topic.size() > msg::kTopicMax) {
            return std::unexpected(Err::invalid_args);
        }
        if (count_ == entries_.size()) {
            return std::unexpected(Err::busy);
        }
        Entry &e = entries_[count_++];
        std::memcpy(e.topic, topic.data(), topic.size());
        e.len = static_cast<uint8_t>(topic.size());
        e.fn = handler;
        return {};
    }

    /** Runs every handler of `topic`, in registration order; returns how many ran. */
    size_t dispatch(uint16_t src, std::string_view topic, std::span<const uint8_t> data)
    {
        size_t ran = 0;
        // count_ as of now: a handler that registers another one does not see it run for this MSG.
        const size_t n = count_;
        for (size_t i = 0; i < n; ++i) {
            if (std::string_view(entries_[i].topic, entries_[i].len) == topic) {
                entries_[i].fn(src, data);
                ++ran;
            }
        }
        return ran;
    }

    size_t size() const { return count_; }

private:
    struct Entry {
        char topic[msg::kTopicMax] = {};
        uint8_t len = 0;
        msg::Handler fn;
    };

    std::array<Entry, msg::kHandlersMax> entries_{};
    size_t count_ = 0;
};

// ---- persistence: nvs:fr_dir, nvs:fr_bind ----

/** One stored blob. */
class Blob
{
public:
    /** The blob into `out`: its size, or 0 when there is none or it does not fit. */
    virtual size_t read(std::span<uint8_t> out) = 0;
    /** Replaces it; false when the write failed. Runs on fr_worker. */
    virtual bool write(std::span<const uint8_t> bytes) = 0;

protected:
    ~Blob() = default;
};

/** Leading byte of both blobs: another version does not load (the hub re-pushes bindings and DIRECTORY). */
inline constexpr uint8_t kStoreVersion = 1;
/** `ver | count | {slot, len, Binding}...` */
inline constexpr size_t kBindBlobMax = 2 + net::kBindingsMax * (2 + proto::Binding::kMaxSize);
/** `ver | count | {addr u16 LE, mac}...` */
inline constexpr size_t kDirEntrySize = 2 + 6;
inline constexpr size_t kDirBlobMax = 2 + net::kDirectoryMax * kDirEntrySize;

inline size_t encode_bindings_blob(const net::BindingTable &t, std::span<uint8_t> out)
{
    if (out.size() < 2) {
        return 0;
    }
    size_t n = 2;
    uint8_t count = 0;
    for (size_t slot = 0; slot < t.size(); ++slot) {
        const std::span<const uint8_t> b = t[slot].encoded();
        if (b.empty()) {
            continue;
        }
        if (n + 2 + b.size() > out.size()) {
            return 0;
        }
        out[n++] = static_cast<uint8_t>(slot);
        out[n++] = static_cast<uint8_t>(b.size());
        std::memcpy(out.data() + n, b.data(), b.size());
        n += b.size();
        ++count;
    }
    out[0] = kStoreVersion;
    out[1] = count;
    return n;
}

/** The table a blob holds; false (`out` untouched) when it is not one this version wrote. Net checks each
 * Binding again as it loads. Checked first, then copied: no 2.7 KB table on the boot task's stack. */
inline bool decode_bindings_blob(std::span<const uint8_t> in, net::BindingTable &out)
{
    if (in.size() < 2 || in[0] != kStoreVersion || in[1] > net::kBindingsMax) {
        return false;
    }
    uint32_t seen = 0;  // slot bits: a slot twice is not a blob this code wrote
    size_t n = 2;
    for (uint8_t i = 0; i < in[1]; ++i) {
        if (n + 2 > in.size()) {
            return false;
        }
        const uint8_t slot = in[n];
        const uint8_t len = in[n + 1];
        n += 2;
        if (slot >= out.size() || (seen & (1u << slot)) != 0 || len == 0 || len > proto::Binding::kMaxSize ||
            n + len > in.size()) {
            return false;
        }
        seen |= 1u << slot;
        n += len;
    }
    if (n != in.size()) {
        return false;
    }
    out.fill(net::BindingSlot{});
    n = 2;
    for (uint8_t i = 0; i < in[1]; ++i) {
        net::BindingSlot &s = out[in[n]];
        s.used = true;
        s.len = in[n + 1];
        std::memcpy(s.bytes, in.data() + n + 2, s.len);
        n += 2 + s.len;
    }
    return true;
}

inline size_t encode_directory_blob(const net::Directory &d, std::span<uint8_t> out)
{
    const size_t count = std::min(d.count, net::kDirectoryMax);
    if (out.size() < 2 + count * kDirEntrySize) {
        return 0;
    }
    out[0] = kStoreVersion;
    out[1] = static_cast<uint8_t>(count);
    size_t n = 2;
    for (size_t i = 0; i < count; ++i) {
        const net::DirEntry &e = d.entries[i];
        out[n++] = static_cast<uint8_t>(e.addr);
        out[n++] = static_cast<uint8_t>(e.addr >> 8);
        std::memcpy(out.data() + n, e.mac.data(), e.mac.size());
        n += e.mac.size();
    }
    return n;
}

inline bool decode_directory_blob(std::span<const uint8_t> in, net::Directory &out)
{
    if (in.size() < 2 || in[0] != kStoreVersion || in[1] > net::kDirectoryMax ||
        in.size() != 2 + size_t{in[1]} * kDirEntrySize) {
        return false;
    }
    out.count = in[1];
    for (size_t i = 0; i < out.count; ++i) {
        const uint8_t *p = in.data() + 2 + i * kDirEntrySize;
        out.entries[i].addr = static_cast<uint16_t>(p[0] | p[1] << 8);
        std::memcpy(out.entries[i].mac.data(), p + 2, out.entries[i].mac.size());
    }
    return true;
}

/**
 * Writes one blob on fr_worker for the core task without either side waiting on the other. Two buffers:
 * the worker writes one while the core task encodes the newest table into the other; a write that ends
 * hands the newer buffer to the worker. Only the core task touches the buffers' ownership; the worker's
 * verdict comes back through an atomic and a post (and retry(), should that post be refused). A table the
 * same as the newest one stored or on its way is not written again: the hub repeats DIRECTORY on every
 * registry change and WELCOME, and flash wears.
 */
template <size_t N>
class BlobWriter
{
public:
    BlobWriter(Core &core, Worker &worker, Blob &blob) : core_(core), worker_(worker), blob_(blob) {}
    BlobWriter(const BlobWriter &) = delete;
    BlobWriter &operator=(const BlobWriter &) = delete;

    /** Core task: `encode(std::span<uint8_t>) -> size_t` fills a buffer; 0 means nothing to write. */
    template <class Encode>
    void save(Encode &&encode)
    {
        const int b = busy_ ? 1 - writing_ : writing_;
        const size_t len = encode(std::span<uint8_t>(bufs_[b], N));
        if (len == 0) {
            ++failures_;
            return;
        }
        const uint32_t hash = wire::fnv1a32({bufs_[b], len});
        if (have_newest_ && hash == newest_hash_ && len == newest_len_) {
            ++skipped_;
            return;
        }
        have_newest_ = true;
        newest_hash_ = hash;
        newest_len_ = len;
        lens_[b] = len;
        if (busy_) {
            waiting_ = true;  // newest wins: an older waiting table is simply overwritten
            return;
        }
        busy_ = true;
        post_write();
    }

    /** Core task, now and then: a write the worker queue refused, a verdict whose post was refused. */
    void retry()
    {
        collect();
        if (busy_ && unposted_) {
            post_write();
        }
    }

    /** Before any save (boot): the idle buffer, to read the stored blob into. */
    std::span<uint8_t> scratch() { return {bufs_[busy_ ? 1 - writing_ : writing_], N}; }
    /** Boot: what flash holds, so saving that same table again writes nothing. */
    void stored(std::span<const uint8_t> blob)
    {
        have_newest_ = true;
        newest_hash_ = wire::fnv1a32(blob);
        newest_len_ = blob.size();
    }

    bool busy() const { return busy_; }
    uint32_t writes() const { return writes_; }
    uint32_t failures() const { return failures_; }
    uint32_t skipped() const { return skipped_; }

private:
    void post_write()
    {
        unposted_ = !worker_.post([this] {
            // fr_worker: the flash write, then the verdict to the core task.
            const bool ok = blob_.write({bufs_[writing_], lens_[writing_]});
            verdict_.store(ok ? 1 : 2, std::memory_order_release);
            core_.post([this] { collect(); });  // refused: retry() collects it
        });
    }

    void collect()
    {
        const uint8_t v = verdict_.exchange(0, std::memory_order_acq_rel);
        if (v == 0 || !busy_) {
            return;
        }
        ++(v == 1 ? writes_ : failures_);
        busy_ = false;
        if (v != 1 && !waiting_) {
            have_newest_ = false;  // not stored after all: the same table saved again is written
        }
        if (waiting_) {
            waiting_ = false;
            writing_ = 1 - writing_;
            busy_ = true;
            post_write();
        }
    }

    Core &core_;
    Worker &worker_;
    Blob &blob_;
    uint8_t bufs_[2][N] = {};
    size_t lens_[2] = {};
    int writing_ = 0;         // the buffer the worker writes (or will)
    bool busy_ = false;       // a write is queued or running
    bool waiting_ = false;    // the other buffer holds a newer blob
    bool unposted_ = false;   // the worker queue refused the write
    std::atomic<uint8_t> verdict_{0};  // fr_worker -> core task: 1 written, 2 failed
    // The newest table stored or on its way (FNV-1a and length).
    bool have_newest_ = false;
    uint32_t newest_hash_ = 0;
    size_t newest_len_ = 0;
    uint32_t writes_ = 0;
    uint32_t failures_ = 0;
    uint32_t skipped_ = 0;
};

/** Net's DirectoryStore and BindingStore (nvs:fr_dir, nvs:fr_bind). */
class NetStores final : public net::DirectoryStore, public net::BindingStore
{
public:
    NetStores(Core &core, Worker &worker, Blob &directory, Blob &bindings)
        : dir_blob_(directory), bind_blob_(bindings), dir_(core, worker, directory), bind_(core, worker, bindings)
    {
    }

    bool load(net::Directory &out) override
    {
        const std::span<uint8_t> buf = dir_.scratch();
        const size_t n = dir_blob_.read(buf);
        if (n == 0 || !decode_directory_blob(buf.first(n), out)) {
            return false;
        }
        dir_.stored(buf.first(n));
        return true;
    }
    void save(const net::Directory &d) override
    {
        dir_.save([&d](std::span<uint8_t> out) { return encode_directory_blob(d, out); });
    }
    bool load(net::BindingTable &out) override
    {
        const std::span<uint8_t> buf = bind_.scratch();
        const size_t n = bind_blob_.read(buf);
        if (n == 0 || !decode_bindings_blob(buf.first(n), out)) {
            return false;
        }
        bind_.stored(buf.first(n));
        return true;
    }
    void save(const net::BindingTable &t) override
    {
        bind_.save([&t](std::span<uint8_t> out) { return encode_bindings_blob(t, out); });
    }

    /** Core task, now and then (fr_core's 250 ms poll): writes or verdicts a full queue refused. */
    void retry()
    {
        dir_.retry();
        bind_.retry();
    }

    net::DirectoryStore *directory() { return this; }
    net::BindingStore *bindings() { return this; }
    const BlobWriter<kDirBlobMax> &directory_writer() const { return dir_; }
    const BlobWriter<kBindBlobMax> &bindings_writer() const { return bind_; }

private:
    Blob &dir_blob_;
    Blob &bind_blob_;
    BlobWriter<kDirBlobMax> dir_;
    BlobWriter<kBindBlobMax> bind_;
};

}  // namespace fr::core
