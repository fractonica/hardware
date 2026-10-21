// Capability base classes (design c2 §4, spec 07 §7.7). Generated per-capability interfaces in gen/
// derive from Capability; fr_core implements Sink and hands dispatch a Reply for the RESULT fields.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/wire.hpp"

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
 * low 32 bits); kNowUs (any negative value) means now.
 */
class Sink
{
public:
    virtual void event(uint8_t port, uint8_t event_id, Priority prio, std::span<const uint8_t> fields, TimeUs at) = 0;
    virtual void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, TimeUs at) = 0;

protected:
    ~Sink() = default;
};

/** RESULT fields, filled by dispatch. Capacity is the 200 B realtime payload budget (spec 07 §7.5). */
class Reply
{
public:
    static constexpr size_t kCapacity = 200;

    Reply() : w_(buf_, kCapacity) {}
    // The writer points into this object's own buffer, so a copy would write into the original.
    Reply(const Reply &) = delete;
    Reply &operator=(const Reply &) = delete;

    fr::wire::Writer &fields() { return w_; }
    std::span<const uint8_t> bytes() const { return w_.bytes(); }

private:
    uint8_t buf_[kCapacity];
    fr::wire::Writer w_;
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
