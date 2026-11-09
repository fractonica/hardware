#include "fr/drv/sdspi_card.hpp"

#include <algorithm>
#include <cerrno>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include "driver/gpio.h"
#include "driver/sdspi_host.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "fr/platform/spi_bus.hpp"
#include "sd_protocol_defs.h"
#include "sdmmc_cmd.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "sdspi";
constexpr spi_host_device_t kHost = SPI2_HOST;

// errno to the store's errors (hal/file_store.hpp): only the card's own I/O failures are Err::failed, the one error the
// service may take for a removed card (and then only when the card no longer answers a status command).
Err from_errno(int e)
{
    switch (e) {
    case ENOENT:
    case ENOTDIR:
        return Err::not_found;
    case ENOTEMPTY:
    case EBUSY:
    case ENOMEM:
    case ENFILE:
    case EMFILE:
    case EAGAIN:
        return Err::busy;
    case EEXIST:
    case EISDIR:
    case EINVAL:
    case ENAMETOOLONG:
    case ENOSPC:
    case EACCES:
    case EPERM:
    case EROFS:
    case EFBIG:
        return Err::invalid_args;
    default:  // EIO, ENODEV, ENXIO, ETIMEDOUT and anything unknown
        return Err::failed;
    }
}

void copy_name(char *dst, size_t cap, const char *src)
{
    std::strncpy(dst, src, cap - 1);
    dst[cap - 1] = '\0';
}

}  // namespace

void SdspiCard::full(const char *path, char *out) const
{
    std::snprintf(out, kPathMax, "%s%s", kBase, std::strcmp(path, "/") == 0 ? "" : path);
}

Status SdspiCard::init(Core &core)
{
    (void)core;
    // CS high before the pin becomes an output, so the card is never selected by the panel's traffic (the board's
    // idle_high holds it high from board init; this keeps it so whatever the order).
    gpio_set_level(static_cast<gpio_num_t>(cfg_.cs), 1);
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.cs;
    io.mode = GPIO_MODE_OUTPUT;
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    gpio_set_level(static_cast<gpio_num_t>(cfg_.cs), 1);
    if (auto st = platform::spi_bus(kHost, {cfg_.sclk, cfg_.mosi, cfg_.miso}, 4096); !st) {
        std::snprintf(detail_, sizeof(detail_), "SPI bus refused (SCLK %u MOSI %u MISO %u)", cfg_.sclk, cfg_.mosi, cfg_.miso);
        return st;
    }
    bus_ok_ = true;
    std::snprintf(detail_, sizeof(detail_), "bus ok, not mounted");
    return {};
}

Status SdspiCard::mount(uint8_t max_files)
{
    if (!bus_ok_) {
        return std::unexpected(Err::failed);
    }
    if (state_ == hal::StoreState::mounted) {
        return {};
    }
    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = kHost;
    host.max_freq_khz = cfg_.speed_khz;
    sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot.host_id = kHost;
    slot.gpio_cs = static_cast<gpio_num_t>(cfg_.cs);
    esp_vfs_fat_sdmmc_mount_config_t mc = {};
    mc.format_if_mount_failed = false;
    mc.max_files = max_files;
    mc.allocation_unit_size = 16 * 1024;
    sdmmc_card_t *card = nullptr;
    const esp_err_t err = esp_vfs_fat_sdspi_mount(kBase, &host, &slot, &mc, &card);
    if (err != ESP_OK) {
        // No card: the card's init times out (or answers nothing usable); a card without a FAT: ESP_FAIL.
        const bool absent = err == ESP_ERR_TIMEOUT || err == ESP_ERR_INVALID_RESPONSE || err == ESP_ERR_NOT_FOUND ||
                            err == ESP_ERR_INVALID_CRC;
        state_ = absent ? hal::StoreState::none : hal::StoreState::error;
        std::snprintf(detail_, sizeof(detail_), "mount: %s", esp_err_to_name(err));
        ESP_LOGW(TAG, "mount: %s", esp_err_to_name(err));
        return std::unexpected(absent ? Err::not_found : Err::failed);
    }
    card_ = card;
    state_ = hal::StoreState::mounted;
    std::snprintf(detail_, sizeof(detail_), "mounted %.8s", card->cid.name);
    ESP_LOGI(TAG, "mounted %.8s, %" PRIu64 " MB, %d kHz", card->cid.name,
             static_cast<uint64_t>(card->csd.capacity) * card->csd.sector_size / (1024 * 1024), card->real_freq_khz);
    return {};
}

void SdspiCard::unmount()
{
    if (state_ == hal::StoreState::mounted && card_ != nullptr) {
        esp_vfs_fat_sdcard_unmount(kBase, static_cast<sdmmc_card_t *>(card_));
    }
    card_ = nullptr;
    state_ = hal::StoreState::none;
    std::snprintf(detail_, sizeof(detail_), "not mounted");
}

Status SdspiCard::info(hal::CardInfo &out)
{
    if (state_ != hal::StoreState::mounted || card_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const auto *card = static_cast<const sdmmc_card_t *>(card_);
    const uint64_t bytes = static_cast<uint64_t>(card->csd.capacity) * card->csd.sector_size;
    out.total_mb = static_cast<uint32_t>(bytes / (1024 * 1024));
    const bool high = (card->ocr & SD_OCR_SDHC_CAP) != 0;
    out.type = !high ? hal::CardType::sdsc : (bytes > 32ULL * 1024 * 1024 * 1024 ? hal::CardType::sdxc : hal::CardType::sdhc);
    std::memcpy(out.name, card->cid.name, std::min(sizeof(out.name) - 1, sizeof(card->cid.name)));
    out.name[sizeof(out.name) - 1] = '\0';
    out.speed_khz = static_cast<uint32_t>(card->real_freq_khz);
    uint64_t total = 0;
    uint64_t free_bytes = 0;
    if (esp_vfs_fat_info(kBase, &total, &free_bytes) == ESP_OK) {
        out.total_mb = static_cast<uint32_t>(total / (1024 * 1024));
        out.free_mb = static_cast<uint32_t>(free_bytes / (1024 * 1024));
    }
    return {};
}

std::expected<size_t, Err> SdspiCard::list(const char *path, uint16_t offset, std::span<hal::FileEntry> out, bool &more)
{
    char dir_path[kPathMax];
    full(path, dir_path);
    errno = 0;
    DIR *d = opendir(dir_path);
    if (d == nullptr) {
        return std::unexpected(from_errno(errno));
    }
    size_t n = 0;
    uint32_t index = 0;
    more = false;
    while (const dirent *e = readdir(d)) {
        if (std::strcmp(e->d_name, ".") == 0 || std::strcmp(e->d_name, "..") == 0) {
            continue;
        }
        if (index++ < offset) {
            continue;
        }
        if (n == out.size()) {
            more = true;
            break;
        }
        hal::FileEntry &fe = out[n++];
        fe = {};
        copy_name(fe.name, sizeof(fe.name), e->d_name);
        char child[kPathMax + 260];
        std::snprintf(child, sizeof(child), "%s/%s", dir_path, e->d_name);
        struct stat st{};
        if (::stat(child, &st) == 0) {
            fe.dir = S_ISDIR(st.st_mode);
            fe.size = fe.dir ? 0 : static_cast<uint32_t>(st.st_size);
            fe.mtime = static_cast<uint32_t>(st.st_mtime);
        } else {
            fe.dir = e->d_type == DT_DIR;
        }
    }
    closedir(d);
    return n;
}

Status SdspiCard::stat(const char *path, hal::FileEntry &out)
{
    char p[kPathMax];
    full(path, p);
    errno = 0;
    struct stat st{};
    if (::stat(p, &st) != 0) {
        return std::unexpected(from_errno(errno));
    }
    out = {};
    const char *slash = std::strrchr(path, '/');
    copy_name(out.name, sizeof(out.name), slash != nullptr ? slash + 1 : path);
    out.dir = S_ISDIR(st.st_mode);
    out.size = out.dir ? 0 : static_cast<uint32_t>(st.st_size);
    out.mtime = static_cast<uint32_t>(st.st_mtime);
    return {};
}

std::expected<size_t, Err> SdspiCard::read(const char *path, uint32_t offset, std::span<uint8_t> out, bool &eof)
{
    char p[kPathMax];
    full(path, p);
    errno = 0;
    FILE *f = std::fopen(p, "rb");
    if (f == nullptr) {
        return std::unexpected(from_errno(errno));
    }
    struct stat st{};
    if (fstat(fileno(f), &st) != 0) {
        const int e = errno;
        std::fclose(f);
        return std::unexpected(from_errno(e));
    }
    const uint32_t size = static_cast<uint32_t>(st.st_size);
    size_t n = 0;
    if (offset < size) {
        if (std::fseek(f, static_cast<long>(offset), SEEK_SET) != 0) {
            const int e = errno;
            std::fclose(f);
            return std::unexpected(from_errno(e));
        }
        const size_t want = std::min<size_t>(out.size(), size - offset);
        n = std::fread(out.data(), 1, want, f);
        if (n != want && std::ferror(f)) {
            std::fclose(f);
            return std::unexpected(Err::failed);
        }
    }
    std::fclose(f);
    eof = offset + n >= size;
    return n;
}

Status SdspiCard::parents(const char *full_path)
{
    char p[kPathMax];
    copy_name(p, sizeof(p), full_path);
    // Each '/' after the base: mkdir the prefix.
    for (char *s = p + std::strlen(kBase) + 1; (s = std::strchr(s, '/')) != nullptr; ++s) {
        *s = '\0';
        if (::mkdir(p, 0775) != 0 && errno != EEXIST) {
            const int e = errno;
            *s = '/';
            return std::unexpected(from_errno(e));
        }
        *s = '/';
    }
    return {};
}

std::expected<uint32_t, Err> SdspiCard::write(const char *path, uint32_t offset, std::span<const uint8_t> data,
                                              bool truncate)
{
    char p[kPathMax];
    full(path, p);
    if (auto st = parents(p); !st) {
        return std::unexpected(st.error());
    }
    errno = 0;
    FILE *f = std::fopen(p, "r+b");
    if (f == nullptr && errno == ENOENT) {
        errno = 0;
        f = std::fopen(p, "w+b");
    }
    if (f == nullptr) {
        return std::unexpected(from_errno(errno));
    }
    int e = 0;
    struct stat st{};
    errno = 0;
    if (fstat(fileno(f), &st) != 0) {
        e = errno != 0 ? errno : EIO;
    } else if (offset > static_cast<uint32_t>(st.st_size)) {
        e = EINVAL;  // past the end: FAT would leave the gap undefined (hal/file_store.hpp)
    } else if (errno = 0, std::fseek(f, static_cast<long>(offset), SEEK_SET) != 0) {
        e = errno != 0 ? errno : EIO;
    } else if (errno = 0, !data.empty() && std::fwrite(data.data(), 1, data.size(), f) != data.size()) {
        e = errno != 0 ? errno : ENOSPC;  // FatFs answers a full card with a short count and no errno
    } else if (errno = 0, std::fflush(f) != 0) {
        e = errno != 0 ? errno : EIO;
    } else if (truncate && (errno = 0, ftruncate(fileno(f), static_cast<off_t>(offset + data.size())) != 0)) {
        e = errno != 0 ? errno : EIO;
    }
    const bool sized = e == 0 && fstat(fileno(f), &st) == 0;
    std::fclose(f);
    if (e != 0) {
        return std::unexpected(from_errno(e));
    }
    return sized ? static_cast<uint32_t>(st.st_size) : static_cast<uint32_t>(offset + data.size());
}

Status SdspiCard::remove(const char *path)
{
    char p[kPathMax];
    full(path, p);
    errno = 0;
    struct stat st{};
    if (::stat(p, &st) != 0) {
        return std::unexpected(from_errno(errno));
    }
    const int r = S_ISDIR(st.st_mode) ? ::rmdir(p) : ::unlink(p);
    if (r != 0) {
        return std::unexpected(from_errno(errno));
    }
    return {};
}

Status SdspiCard::mkdir(const char *path)
{
    char p[kPathMax];
    full(path, p);
    if (auto st = parents(p); !st) {
        return st;
    }
    errno = 0;
    if (::mkdir(p, 0775) != 0) {
        struct stat st{};
        if (errno == EEXIST && ::stat(p, &st) == 0 && S_ISDIR(st.st_mode)) {
            return {};
        }
        return std::unexpected(from_errno(errno));
    }
    return {};
}

Status SdspiCard::rename(const char *from, const char *to)
{
    char a[kPathMax];
    char b[kPathMax];
    full(from, a);
    full(to, b);
    if (auto st = parents(b); !st) {
        return st;
    }
    errno = 0;
    if (std::rename(a, b) != 0) {
        return std::unexpected(from_errno(errno));
    }
    return {};
}

bool SdspiCard::card_alive()
{
    if (state_ != hal::StoreState::mounted || card_ == nullptr) {
        return false;
    }
    return sdmmc_get_status(static_cast<sdmmc_card_t *>(card_)) == ESP_OK;
}

hal::Selftest SdspiCard::selftest()
{
    return {bus_ok_ && state_ != hal::StoreState::error, detail_};
}

}  // namespace fr::drv
