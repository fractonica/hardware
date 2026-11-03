// L1 settings contract (design scale-round-c1 D6): small integers a service keeps across reboots, by key. The first
// capability state kept on the node (fr.scale's offset and scale factor). fr::platform::NvsSettings is the target's
// (one NVS namespace, the writes on fr_worker); the host suite has a map in memory.
//
// Keys are at most kKeyMax characters (NVS's limit) and unique within the store; a service with several instances
// puts its port in its keys.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/base.hpp"

namespace fr::hal {

class Settings
{
public:
    /** NVS keys: 15 characters and the terminator. */
    static constexpr size_t kKeyMax = 15;
    /** Keys one erase() forgets at most. */
    static constexpr size_t kEraseMax = 2;

    /** The value kept under `key`: Err::not_found when none, Err::failed when the store cannot be read. */
    virtual std::expected<int32_t, Err> get_i32(const char *key) = 0;
    /**
     * Keeps `value` under `key` across reboots. The write may land a moment later (NVS: on fr_worker, so flash never
     * stalls the core task); writes land in the order they were made. Err::busy when it cannot be queued now,
     * Err::invalid_args for a key longer than kKeyMax.
     */
    virtual Status set_i32(const char *key, int32_t value) = 0;
    /**
     * Forgets every key of `keys` (at most kEraseMax; OK for one that was not there) as one write: all of them are
     * queued or none is (Err::busy), so a store is never left with some forgotten and not the others. set_i32's
     * ordering; Err::invalid_args for no key, too many or one too long.
     */
    virtual Status erase(std::span<const char *const> keys) = 0;

protected:
    ~Settings() = default;
};

}  // namespace fr::hal
