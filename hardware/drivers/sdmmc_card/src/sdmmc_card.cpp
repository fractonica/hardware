// sdmmc_card (design camera-c1 D8, D9, §9, §10): hal::BlockStore on a FAT micro-SD card over the SD/MMC host. The header
// says what runs where; this file is the only one that includes esp_vfs_fat.h and sdmmc_cmd.h (spec 03 §3.2). The mount
// is the spike's (camspike, design §9: 1-bit, internal pull-ups, 20 MHz, no auto-format, mounted in 63 ms).
//
// Layout on the card (fr/drv/sdmmc_layout.hpp): `/sdcard/fr/<id 8 hex>/<index / 1000, 3 digits>/<index % 1000, 3
// digits>.jpg`, every name 8.3-safe, and `meta.bin` in each recording's directory, written at close: `frames u32 LE |
// bytes u32 LE`, so a list reads one small file per recording instead of stat'ing hundreds of frames. A directory
// without it (a recording cut by a reset) is counted by readdir. Everything but init() runs on the fr_stream task: a
// walk over a long recording (remove, count) takes seconds on a 1-bit card and must never hold the core task.
#include "fr/drv/sdmmc_card.hpp"

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdio>
#include <cstring>

#include "driver/sdmmc_host.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "sdkconfig.h"
#include "sdmmc_cmd.h"
#include "soc/soc_caps.h"

namespace fr::drv {
namespace {

namespace layout = sdmmc_layout;
using layout::Path;

constexpr const char *TAG = "sdmmc_card";
/** Recordings a list() can sort: ids read from the root directory into a stack array (fr_stream's, 1 KB). */
constexpr size_t kListMax = 256;

void put_u32le(uint8_t *p, uint32_t v)
{
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
    p[2] = static_cast<uint8_t>(v >> 16);
    p[3] = static_cast<uint8_t>(v >> 24);
}

uint32_t get_u32le(const uint8_t *p)
{
    return static_cast<uint32_t>(p[0]) | static_cast<uint32_t>(p[1]) << 8 | static_cast<uint32_t>(p[2]) << 16 |
           static_cast<uint32_t>(p[3]) << 24;
}

/** meta.bin of `id`: true when it is there and whole. */
bool read_meta(uint32_t id, hal::Recording &out)
{
    Path path;
    layout::meta_path(path, id);
    FILE *f = std::fopen(path, "rb");
    if (f == nullptr) {
        return false;
    }
    uint8_t buf[8];
    const size_t n = std::fread(buf, 1, sizeof(buf), f);
    std::fclose(f);
    if (n != sizeof(buf)) {
        return false;
    }
    out.id = id;
    out.frames = get_u32le(buf);
    out.bytes = get_u32le(buf + 4);
    return true;
}

/** `<dir>/<name>` into `out` (8.3 names: at most 12 characters). */
void join(char (&out)[layout::kPathMax + 16], const char *dir, const char *name)
{
    std::snprintf(out, sizeof(out), "%s/%.15s", dir, name);
}

/** A recording without meta.bin: its frames counted by readdir over the shards, their bytes by stat (the exceptional path). */
void count_frames(uint32_t id, hal::Recording &out)
{
    out.id = id;
    out.frames = 0;
    out.bytes = 0;
    Path dir;
    layout::dir_path(dir, id);
    DIR *d = opendir(dir);
    if (d == nullptr) {
        return;
    }
    while (const dirent *e = readdir(d)) {
        uint32_t shard = 0;
        if (!layout::parse_shard(e->d_name, shard)) {
            continue;
        }
        char sp[layout::kPathMax + 16];
        join(sp, dir, e->d_name);
        DIR *s = opendir(sp);
        if (s == nullptr) {
            continue;
        }
        while (const dirent *fe = readdir(s)) {
            uint32_t slot = 0;
            if (!layout::parse_frame(fe->d_name, slot)) {
                continue;
            }
            ++out.frames;
            char fp[layout::kPathMax + 32];
            std::snprintf(fp, sizeof(fp), "%s/%.15s", sp, fe->d_name);
            struct stat st = {};
            if (stat(fp, &st) == 0) {
                out.bytes += static_cast<uint32_t>(st.st_size);
            }
        }
        closedir(s);
    }
    closedir(d);
}

}  // namespace

Status SdmmcCard::init(Core &core)
{
    core_ = &core;
    state_ = hal::StoreState::none;
    free_mb_ = 0;
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.slot = cfg_.slot;
    host.flags = SDMMC_HOST_FLAG_1BIT;  // v1 is 1-bit (design D9): D1-D3 stay other pins' (the flash LED on D1)
    host.max_freq_khz = cfg_.freq_khz;
    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    slot.width = cfg_.width;
    slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
#if SOC_SDMMC_USE_GPIO_MATRIX
    // The S3 routes the slot through the GPIO matrix: the board entry's pins. The ESP32's slot pins are fixed by IOMUX
    // (slot 1: CLK 14, CMD 15, D0 2) and the fields are ignored there.
    slot.clk = static_cast<gpio_num_t>(cfg_.clk);
    slot.cmd = static_cast<gpio_num_t>(cfg_.cmd);
    slot.d0 = static_cast<gpio_num_t>(cfg_.d0);
#endif
    esp_vfs_fat_sdmmc_mount_config_t mount = {};
    mount.format_if_mount_failed = false;  // the Mac formats cards (design D7: no sd_format)
    mount.max_files = 4;
    mount.allocation_unit_size = 16 * 1024;
    mount.disk_status_check_enable = false;
    mount.use_one_fat = false;
    sdmmc_card_t *card = nullptr;
    const esp_err_t err = esp_vfs_fat_sdmmc_mount(kMount, &host, &slot, &mount, &card);
    if (err == ESP_ERR_TIMEOUT || err == ESP_ERR_NOT_FOUND) {
        ESP_LOGI(TAG, "no card in the slot (%s)", esp_err_to_name(err));
        return {};  // state none: the module runs without its store
    }
    if (err == ESP_ERR_NO_MEM || err == ESP_ERR_INVALID_STATE || err == ESP_ERR_INVALID_ARG) {
        // The host itself failed: state error and Err::failed; the service runs the camera without its store.
        ESP_LOGE(TAG, "SD/MMC host fault: %s", esp_err_to_name(err));
        state_ = hal::StoreState::error;
        return std::unexpected(Err::failed);
    }
    if (err != ESP_OK) {
        // The card answered but will not mount (no FAT, a bad CRC): the state says so, the camera still runs.
        ESP_LOGW(TAG, "card not mounted: %s", esp_err_to_name(err));
        state_ = hal::StoreState::error;
        return {};
    }
    card_ = card;
    state_ = hal::StoreState::mounted;
    if (mkdir(kRoot, 0775) != 0 && errno != EEXIST) {
        ESP_LOGW(TAG, "mkdir %s: errno %d", kRoot, errno);
    }
    refresh_free();
    uint64_t fat_total = 0;
    uint64_t fat_free = 0;
    static_cast<void>(esp_vfs_fat_info(kMount, &fat_total, &fat_free));  // the raw figures beside the MB (bench 18)
    ESP_LOGI(TAG, "card mounted at %s: %s, %llu MB, %u-bit at %d kHz; FAT %llu B, %llu B free = %lu MB", kMount,
             card->cid.name,
             static_cast<unsigned long long>((static_cast<uint64_t>(card->csd.capacity) * card->csd.sector_size) >> 20),
             static_cast<unsigned>(cfg_.width), static_cast<int>(card->max_freq_khz),
             static_cast<unsigned long long>(fat_total), static_cast<unsigned long long>(fat_free),
             static_cast<unsigned long>(free_mb()));
    return {};
}

void SdmmcCard::refresh_free()
{
    // f_getfree walks the FAT when FatFs has no cached count (a fresh mount, a card written by another host): seconds
    // on a big card, so fr_stream only (init's call is before any task runs).
    // Everything in 64 bits until the MB figure: a 32 GB card's bytes (or its free clusters times the cluster size)
    // do not fit 32 (bench 18: a u32 step read 27,539 MB free as 2963). esp_vfs_fat_info is uint64_t on both sides
    // in IDF 6.1 (clusters * csize * sector size, each widened first).
    uint64_t total_bytes = 0;
    uint64_t free_bytes = 0;
    if (esp_vfs_fat_info(kMount, &total_bytes, &free_bytes) == ESP_OK) {
        const uint64_t mb = free_bytes / (uint64_t{1} << 20);
        free_mb_.store(mb > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(mb), std::memory_order_relaxed);
        ESP_LOGD(TAG, "fat: %llu B total, %llu B free (%lu MB)", static_cast<unsigned long long>(total_bytes),
                 static_cast<unsigned long long>(free_bytes), static_cast<unsigned long>(free_mb()));
    } else {
        ESP_LOGW(TAG, "esp_vfs_fat_info failed: free space not refreshed");
    }
}

bool SdmmcCard::clear_recording(uint32_t id, bool rmdir_too)
{
    Path dir;
    layout::dir_path(dir, id);
    DIR *d = opendir(dir);
    if (d == nullptr) {
        return true;  // nothing there
    }
    bool ok = true;
    while (const dirent *e = readdir(d)) {
        if (std::strcmp(e->d_name, ".") == 0 || std::strcmp(e->d_name, "..") == 0) {
            continue;
        }
        char ep[layout::kPathMax + 16];
        join(ep, dir, e->d_name);
        uint32_t shard = 0;
        if (!layout::parse_shard(e->d_name, shard)) {
            ok = unlink(ep) == 0 && ok;  // the meta, or a stray file
            continue;
        }
        if (DIR *s = opendir(ep); s != nullptr) {
            while (const dirent *fe = readdir(s)) {
                if (std::strcmp(fe->d_name, ".") == 0 || std::strcmp(fe->d_name, "..") == 0) {
                    continue;
                }
                char fp[layout::kPathMax + 32];
                std::snprintf(fp, sizeof(fp), "%s/%.15s", ep, fe->d_name);
                ok = unlink(fp) == 0 && ok;
            }
            closedir(s);
        }
        ok = rmdir(ep) == 0 && ok;
    }
    closedir(d);
    if (rmdir_too) {
        ok = rmdir(dir) == 0 && ok;
    }
    return ok;
}

Status SdmmcCard::open_recording(uint32_t id)
{
    if (state_ != hal::StoreState::mounted) {
        return std::unexpected(Err::unsupported);
    }
    if (open_) {
        return std::unexpected(Err::busy);
    }
    Path path;
    layout::dir_path(path, id);
    struct stat st = {};
    if (stat(path, &st) == 0) {
        // A recording of this id again (a reused stream id): its frames and meta would mix with or misdescribe the new
        // ones, so the directory is emptied first (a walk: the stream's first frame comes after it).
        if (!clear_recording(id, false)) {
            ESP_LOGW(TAG, "clear %s: errno %d", path, errno);
        }
    } else if (mkdir(path, 0775) != 0 && errno != EEXIST) {
        ESP_LOGW(TAG, "mkdir %s: errno %d", path, errno);
        write_failed_ = true;
        return std::unexpected(Err::failed);
    }
    open_ = true;
    open_id_ = id;
    open_frames_ = 0;
    open_bytes_ = 0;
    open_shard_ = UINT32_MAX;
    return {};
}

Status SdmmcCard::write_frame(uint32_t index, std::span<const uint8_t> jpeg)
{
    if (!open_) {
        return std::unexpected(Err::unsupported);
    }
    if (index >= layout::kFramesMax) {
        ESP_LOGW(TAG, "frame %lu: past the layout's %lu per recording", static_cast<unsigned long>(index),
                 static_cast<unsigned long>(layout::kFramesMax));
        return std::unexpected(Err::failed);
    }
    Path path;
    if (layout::frame_shard(index) != open_shard_) {
        layout::shard_path(path, open_id_, index);
        if (mkdir(path, 0775) != 0 && errno != EEXIST) {
            ESP_LOGW(TAG, "mkdir %s: errno %d", path, errno);
            write_failed_ = true;
            return std::unexpected(Err::failed);
        }
        open_shard_ = layout::frame_shard(index);
    }
    layout::frame_path(path, open_id_, index);
    FILE *f = std::fopen(path, "wb");
    if (f == nullptr) {
        ESP_LOGW(TAG, "fopen %s: errno %d", path, errno);
        write_failed_ = true;
        return std::unexpected(Err::failed);
    }
    const size_t n = std::fwrite(jpeg.data(), 1, jpeg.size(), f);
    bool ok = n == jpeg.size();
    ok = std::fclose(f) == 0 && ok;  // f_close syncs the file: every frame is on the card once this returns
    if (!ok) {
        ESP_LOGW(TAG, "write %s: %u of %u bytes, errno %d", path, static_cast<unsigned>(n),
                 static_cast<unsigned>(jpeg.size()), errno);
        write_failed_ = true;
        return std::unexpected(Err::failed);
    }
    ++open_frames_;
    open_bytes_ += static_cast<uint32_t>(jpeg.size());
    return {};
}

Status SdmmcCard::close_recording()
{
    if (!open_) {
        return {};
    }
    open_ = false;
    Path path;
    layout::meta_path(path, open_id_);
    uint8_t buf[8];
    put_u32le(buf, open_frames_);
    put_u32le(buf + 4, open_bytes_);
    bool ok = false;
    if (FILE *f = std::fopen(path, "wb"); f != nullptr) {
        ok = std::fwrite(buf, 1, sizeof(buf), f) == sizeof(buf);
        ok = std::fclose(f) == 0 && ok;
    }
    refresh_free();
    if (!ok) {
        ESP_LOGW(TAG, "meta of %08lx not written (errno %d): the list counts its frames", static_cast<unsigned long>(open_id_),
                 errno);
        write_failed_ = true;
        return std::unexpected(Err::failed);
    }
    return {};
}

Status SdmmcCard::list(uint32_t from, std::span<hal::Recording> out, uint32_t &count, uint32_t &next)
{
    count = 0;
    next = 0;
    if (state_ != hal::StoreState::mounted) {
        return std::unexpected(Err::unsupported);
    }
    std::array<uint32_t, kListMax> ids{};
    size_t n = 0;
    DIR *d = opendir(kRoot);
    if (d == nullptr) {
        return {};  // no root yet: nothing recorded
    }
    while (const dirent *e = readdir(d)) {
        uint32_t id = 0;
        if (layout::parse_id(e->d_name, id) && n < ids.size()) {
            ids[n++] = id;
        }
    }
    closedir(d);
    // By id: the hub issues stream ids in order within one run, so this is oldest first for one run's recordings;
    // across hub runs the ids start over and the order is not by time.
    std::sort(ids.begin(), ids.begin() + static_cast<std::ptrdiff_t>(n));
    for (size_t i = from; i < n && count < out.size(); ++i) {
        static_cast<void>(info(ids[i], out[count]));
        ++count;
    }
    next = from + count < n ? from + count : 0;
    return {};
}

Status SdmmcCard::info(uint32_t id, hal::Recording &out)
{
    if (state_ != hal::StoreState::mounted) {
        return std::unexpected(Err::unsupported);
    }
    if (open_ && id == open_id_) {
        out = {.id = id, .frames = open_frames_, .bytes = open_bytes_};
        return {};
    }
    Path path;
    layout::dir_path(path, id);
    struct stat st = {};
    if (stat(path, &st) != 0 || !S_ISDIR(st.st_mode)) {
        return std::unexpected(Err::not_found);
    }
    if (!read_meta(id, out)) {
        count_frames(id, out);
    }
    return {};
}

Status SdmmcCard::read_frame(uint32_t id, uint32_t index, std::span<uint8_t> buf, uint32_t &len)
{
    len = 0;
    if (state_ != hal::StoreState::mounted) {
        return std::unexpected(Err::unsupported);
    }
    if (open_) {
        return std::unexpected(Err::busy);
    }
    if (index >= layout::kFramesMax) {
        return std::unexpected(Err::not_found);
    }
    Path path;
    layout::frame_path(path, id, index);
    struct stat st = {};
    if (stat(path, &st) != 0) {
        return std::unexpected(Err::not_found);
    }
    if (static_cast<uint64_t>(st.st_size) > buf.size()) {
        return std::unexpected(Err::invalid_args);
    }
    FILE *f = std::fopen(path, "rb");
    if (f == nullptr) {
        return std::unexpected(Err::not_found);
    }
    const size_t n = std::fread(buf.data(), 1, static_cast<size_t>(st.st_size), f);
    std::fclose(f);
    if (n != static_cast<size_t>(st.st_size)) {
        return std::unexpected(Err::failed);
    }
    len = static_cast<uint32_t>(n);
    return {};
}

Status SdmmcCard::remove(uint32_t id)
{
    if (state_ != hal::StoreState::mounted) {
        return std::unexpected(Err::unsupported);
    }
    if (open_ && id == open_id_) {
        return std::unexpected(Err::busy);
    }
    const bool ok = clear_recording(id, true);
    refresh_free();
    if (!ok) {
        ESP_LOGW(TAG, "remove %08lx: errno %d", static_cast<unsigned long>(id), errno);
        return std::unexpected(Err::failed);
    }
    return {};
}

hal::Selftest SdmmcCard::selftest()
{
    switch (state_) {
    case hal::StoreState::none:
        return {true, "sdmmc_card: no card fitted"};
    case hal::StoreState::error:
        return {false, "sdmmc_card: card did not mount"};
    case hal::StoreState::mounted:
        break;
    }
    if (write_failed_) {
        return {false, "sdmmc_card: mounted, a write failed"};
    }
    return {true, "sdmmc_card: mounted, writes ok"};
}

}  // namespace fr::drv
