// sdspi_card (design lcd-clock-c1 D6; spec 07 §7.8): hal::FileStore on a micro-SD in SPI mode, FAT through the VFS at
// /sd, on fr_core's shared SPI bus (the C6-LCD-1.47's TF slot shares SPI2 with its panel).
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/file_store.hpp"

namespace fr::drv {

/**
 * init: CS held high (deselected), so the panel's traffic never reaches the card, and the shared bus brought up (or
 * joined) with SCLK/MOSI/MISO; no card access. mount: esp_vfs_fat_sdspi_mount (no format; the card's init at 400 kHz,
 * then speed_khz), Err::not_found when no card answers, Err::failed for a card without a FAT. Paths are prefixed with
 * the VFS base /sd. Errors: ENOENT/ENOTDIR -> not_found, ENOTEMPTY/EBUSY -> busy, EEXIST/EISDIR/EINVAL/ENAMETOOLONG/
 * ENOSPC -> invalid_args, anything else (EIO: the card went away) -> failed.
 */
class SdspiCard final : public hal::FileStore
{
public:
    struct Config {
        uint8_t cs = 0;
        uint8_t sclk = 0;
        uint8_t mosi = 0;
        uint8_t miso = 0;
        uint16_t speed_khz = 20000;
    };

    static constexpr const char *kBase = "/sd";

    explicit SdspiCard(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    Status mount(uint8_t max_files) override;
    void unmount() override;
    hal::StoreState state() const override { return state_; }
    Status info(hal::CardInfo &out) override;
    std::expected<size_t, Err> list(const char *path, uint16_t offset, std::span<hal::FileEntry> out, bool &more) override;
    Status stat(const char *path, hal::FileEntry &out) override;
    std::expected<size_t, Err> read(const char *path, uint32_t offset, std::span<uint8_t> out, bool &eof) override;
    std::expected<uint32_t, Err> write(const char *path, uint32_t offset, std::span<const uint8_t> data,
                                       bool truncate) override;
    Status remove(const char *path) override;
    Status mkdir(const char *path) override;
    Status rename(const char *from, const char *to) override;
    bool card_alive() override;
    hal::Selftest selftest() override;

private:
    /** kBase + path into `out` (kPathMax). */
    void full(const char *path, char *out) const;
    /** mkdir -p of `full_path`'s parent directories. */
    Status parents(const char *full_path);

    static constexpr size_t kPathMax = 112;

    Config cfg_;
    bool bus_ok_ = false;
    hal::StoreState state_ = hal::StoreState::none;
    void *card_ = nullptr;  // sdmmc_card_t *
    char detail_[80] = {};
};

}  // namespace fr::drv
