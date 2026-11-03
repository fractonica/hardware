// L1 block store contract (spec 07 §7.7; design camera-c1 D8, D9, §10): the module's own store of recordings, a FAT
// micro-SD card on the SD/MMC host (sdmmc_card). A recording is a directory of frames named by the stream id that made
// it (`/sdcard/fr/<id 8 hex>/...`, the driver's layout); the store mounts, writes and reads frames, lists and removes
// recordings. CameraService decides when (design D8: the card first, then the hub, for `to both`).
//
// Threading: init() runs at board init (the mount: about 60 ms on the bench card; a missing card is state none, not a
// failure; a host fault is state error and Err::failed, which the service logs and runs without the store). Every
// other call is fr_stream-only and may block: open_recording(), write_frame(), close_recording() and read_frame() are
// FAT I/O over 1-bit SDIO (a 20 KB frame in about 100 ms on the bench), and list(), info() and remove() are FAT walks
// (a remove of 3600 frames takes tens of seconds; a free-space refresh scans the FAT). The core task never calls the
// store: CameraService answers sd_list from a cache fr_stream refreshes, runs sd_delete and sd_fetch's info() on
// fr_stream, and reads state() and free_mb() only (atomics or set-at-init). The driver owns everything IDF-specific:
// esp_vfs_fat_sdmmc_mount, sdmmc_host, the VFS paths.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** The store's state (fr.camera CardState, same values). */
enum class StoreState : uint8_t { none = 0, mounted = 1, error = 2 };

/** One recording (fr.camera Recording): the stream id that made it, its frames and their bytes. */
struct Recording {
    uint32_t id = 0;
    uint32_t frames = 0;
    uint32_t bytes = 0;
};

/** A store of recordings on a removable card (sdmmc_card). */
class BlockStore
{
public:
    /**
     * Mounts the card (no auto-format); OK with state none when no card answers, Err::failed (and state error) only
     * for a host fault. Board init.
     */
    virtual Status init(Core &core) = 0;
    /** Set at init; any task. */
    virtual StoreState state() const = 0;
    bool mounted() const { return state() == StoreState::mounted; }
    /** Free space; 0 when not mounted. An atomic the driver refreshes on fr_stream; any task. */
    virtual uint32_t free_mb() const = 0;
    /**
     * Begins recording `id` (its directory made, or emptied when the id was recorded before, so a reused id never mixes
     * two recordings); Err::busy while one is open, Err::unsupported when not mounted, Err::failed when the card
     * refuses (full: the service ends the stream overflow). fr_stream task.
     */
    virtual Status open_recording(uint32_t id) = 0;
    /** Writes frame `index` of the open recording whole (one file, synced by its close); Err::failed: full or faulty. fr_stream task. */
    virtual Status write_frame(uint32_t index, std::span<const uint8_t> jpeg) = 0;
    /** Ends the open recording (its meta written); OK when none is open. fr_stream task. */
    virtual Status close_recording() = 0;
    /**
     * Recordings from the `from`-th, by id (the hub issues them in order within one run: oldest first for that run,
     * not time-ordered across runs), into `out` (at most out.size()): `count` filled, `next` the index to continue
     * from (0: none left). Err::unsupported when not mounted. fr_stream task (a directory walk).
     */
    virtual Status list(uint32_t from, std::span<Recording> out, uint32_t &count, uint32_t &next) = 0;
    /** One recording's figures; Err::not_found. fr_stream task (a recording without its meta is counted by readdir). */
    virtual Status info(uint32_t id, Recording &out) = 0;
    /**
     * Frame `index` of recording `id` into `buf` (`len` its bytes); Err::not_found for either, Err::invalid_args when
     * it does not fit buf, Err::busy while a recording is open for writing. fr_stream task.
     */
    virtual Status read_frame(uint32_t id, uint32_t index, std::span<uint8_t> buf, uint32_t &len) = 0;
    /** Removes recording `id` and its frames; OK when already gone, Err::busy while it is open. fr_stream task (seconds). */
    virtual Status remove(uint32_t id) = 0;
    /** The card is mounted (or none is fitted and the state says so) and the last write did not fail. */
    virtual Selftest selftest() = 0;

protected:
    ~BlockStore() = default;
};

}  // namespace fr::hal
