// sdmmc_card (design camera-c1 D9, §10; spec 07 §7.8): hal::BlockStore on a FAT micro-SD card over the SD/MMC host.
// CameraService calls init() at board init and everything else from the fr_stream task: the recording I/O
// (open_recording/write_frame/close_recording/read_frame) and the FAT walks (list/info/remove), which may take seconds
// on a big recording (fr/hal/block_store.hpp says what runs where).
#pragma once

#include <atomic>
#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/drv/sdmmc_layout.hpp"
#include "fr/hal/block_store.hpp"

namespace fr::drv {

/**
 * init() mounts `/sdcard` (esp_vfs_fat_sdmmc_mount: SDMMC_HOST_DEFAULT at `slot`, 1-bit, the slot with the internal
 * pull-ups, `freq_khz`, format_if_mount_failed false, max_files 4) and makes `/sdcard/fr`; no card (ESP_ERR_TIMEOUT /
 * ESP_ERR_NOT_FOUND) is state none, a card that will not mount state error (both OK: the camera runs without its
 * store), a host fault (no memory, invalid state) state error and Err::failed (the service logs it through the
 * driver and runs without the store). A card inserted after boot is not noticed (design D9).
 * Recordings are directories `/sdcard/fr/<id 8 hex>` (sdmmc_layout.hpp: the frames sharded into sub-directories of
 * kShardFrames, `<index / 1000>/<index % 1000>.jpg`), each frame one file written whole (fwrite; its fclose syncs it:
 * FatFs f_close is f_sync, so a reset loses at most the frame being written), and a `meta.bin` (`frames u32 LE |
 * bytes u32 LE`) written at close; every name is 8.3-safe. open_recording of an id already on the card first removes
 * what that directory holds (frames and meta), so a reused id never mixes two recordings. list() reads the root
 * directory, sorts the ids and fills each entry from its meta (a recording without one, cut by a reset, is counted by
 * readdir); the order is by id, which the hub issues in order within one run (not time-ordered across hub runs).
 * remove() unlinks the frames, the shard directories, the meta and the directory. free_mb() is esp_vfs_fat_info's,
 * refreshed at init, after every recording and after a remove (f_getfree scans the FAT: fr_stream only).
 */
class SdmmcCard final : public hal::BlockStore
{
public:
    // driver.yaml `config` order.
    struct Config {
        uint8_t slot = 1;
        uint8_t width = 1;
        uint8_t clk = 0;
        uint8_t cmd = 0;
        uint8_t d0 = 0;
        uint16_t freq_khz = 20000;
    };

    static constexpr const char *kMount = sdmmc_layout::kMount;
    static constexpr const char *kRoot = sdmmc_layout::kRoot;

    // Only stores the configuration: the host is touched once init() runs (spec 03 §3.4).
    explicit SdmmcCard(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    hal::StoreState state() const override { return state_; }
    uint32_t free_mb() const override { return free_mb_.load(std::memory_order_relaxed); }
    Status open_recording(uint32_t id) override;
    Status write_frame(uint32_t index, std::span<const uint8_t> jpeg) override;
    Status close_recording() override;
    Status list(uint32_t from, std::span<hal::Recording> out, uint32_t &count, uint32_t &next) override;
    Status info(uint32_t id, hal::Recording &out) override;
    Status read_frame(uint32_t id, uint32_t index, std::span<uint8_t> buf, uint32_t &len) override;
    Status remove(uint32_t id) override;
    hal::Selftest selftest() override;

private:
    void refresh_free();
    /** Unlinks a recording's frames, shard directories and meta; `rmdir_too` removes the directory as well. */
    bool clear_recording(uint32_t id, bool rmdir_too);

    Config cfg_;
    Core *core_ = nullptr;
    void *card_ = nullptr;  // sdmmc_card_t *, the mounted card
    hal::StoreState state_ = hal::StoreState::none;  // set at init only
    std::atomic<uint32_t> free_mb_{0};                 // refreshed on the fr_stream task, read by the core task's timer
    bool write_failed_ = false;
    // ---- fr_stream task: the open recording ----
    bool open_ = false;
    uint32_t open_id_ = 0;
    uint32_t open_frames_ = 0;
    uint32_t open_bytes_ = 0;
    uint32_t open_shard_ = UINT32_MAX;  // the shard directory made last (UINT32_MAX: none yet)
};

}  // namespace fr::drv
