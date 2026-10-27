// Capability base classes (design c2 §4, spec 07 §7.7). Generated per-capability interfaces in gen/
// derive from Capability; fr_core implements Sink and hands dispatch a Reply for the RESULT fields.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/envelope.hpp"
#include "fr/wire.hpp"
#include "protocol.hpp"  // generated fr::proto constants (MTU, payload budget)

namespace fr::cap {

struct Version {
    uint8_t major, minor;
};

enum class Priority : uint8_t { realtime, normal, bulk };

/** An emission's `at` when the event happens as it is emitted: the Sink stamps it with Core::now(). */
inline constexpr TimeUs kNowUs = -1;

/**
 * Implemented by fr_core: turns emissions into EVENT/STATE envelopes. `at` is when the event or change
 * happened on the esp_timer clock (an ISR's edge timestamp, say), which becomes the envelope's t_us (its
 * low 32 bits); kNowUs (any negative value) means now. `ordered` is the capability's kOrdered (design
 * m2-c3-inputs D8): the event's port is ordered, so the sink stamps EXT port_seq and keeps it on one route.
 */
class Sink
{
public:
    virtual void event(uint8_t port, uint8_t event_id, Priority prio, std::span<const uint8_t> fields, TimeUs at,
                       bool ordered = false) = 0;
    virtual void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, TimeUs at) = 0;

protected:
    ~Sink() = default;
};

/**
 * RESULT fields, filled by dispatch into a buffer the caller provides (design c3 §2): kRealtimeCapacity
 * for realtime dispatch (UDP), kBulkCapacity when the request arrived on TCP or serial, where the RESULT
 * may go BULK. Fields that do not fit make the generated dispatch answer FAILED with the reply cleared,
 * never truncated; overflowed() still says so after the clear, so the runtime can tell "did not fit this link"
 * from a failure of the capability (design m2-c4-gateway D10: UNSUPPORTED over the gateway). StaticReply<N>
 * carries its own buffer.
 */
class Reply
{
public:
    /** The realtime payload budget (spec 07 §7.5): 200 B. */
    static constexpr size_t kRealtimeCapacity = fr::proto::kRealtimePayloadBudget;
    /** The bulk MTU less the header and the RESULT prefix (1445 B), so the RESULT envelope fits 1470 B. */
    static constexpr size_t kBulkCapacity = fr::proto::kMtuBulk - fr::wire::kHeaderSize - fr::wire::kResultPrefixSize;

    explicit Reply(std::span<uint8_t> buf) : w_(buf) {}
    // The writer points into the caller's buffer; a copy would share it.
    Reply(const Reply &) = delete;
    Reply &operator=(const Reply &) = delete;

    fr::wire::Writer &fields() { return w_; }
    std::span<const uint8_t> bytes() const { return w_.bytes(); }
    size_t capacity() const { return w_.capacity(); }
    /** Drops what was written: FAILED answers carry no fields. An overflow before it stays in overflowed(). */
    void clear()
    {
        overflowed_ = overflowed_ || w_.overflow();
        w_.reset();
    }
    /** Fields beyond capacity() were written at some point (before a clear() too). */
    bool overflowed() const { return overflowed_ || w_.overflow(); }

private:
    fr::wire::Writer w_;
    bool overflowed_ = false;
};

namespace detail {
template <size_t N>
struct ReplyStorage {
    uint8_t buf[N];
};
}  // namespace detail

/** A Reply with inline storage (a base, so the buffer exists before Reply points at it). */
template <size_t N = Reply::kRealtimeCapacity>
class StaticReply : private detail::ReplyStorage<N>, public Reply
{
public:
    StaticReply() : Reply(std::span<uint8_t>(detail::ReplyStorage<N>::buf)) {}
};

class Capability
{
public:
    virtual uint16_t cap_id() const = 0;
    virtual Version version() const = 0;
    virtual const char *type_name() const = 0;  // "fr.button"
    virtual Status dispatch(uint8_t cmd_id, std::span<const uint8_t> args, Reply &reply) = 0;
    virtual void report_all() = 0;                              // get_state: re-report every property
    virtual void encode_traits(fr::wire::Writer &w) const = 0;  // descriptor traits bytes

    /** Called by the runtime before the service's init(). */
    void attach(uint8_t port, const char *name, Sink &sink);
    uint8_t port() const { return port_; }
    const char *name() const { return name_; }

protected:
    ~Capability() = default;

    Sink *sink_ = nullptr;
    uint8_t port_ = 0xFF;
    const char *name_ = "";
};

}  // namespace fr::cap
