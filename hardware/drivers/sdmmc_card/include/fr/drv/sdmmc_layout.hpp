// sdmmc_card's layout on the card (design camera-c1 D8, §10): the path math alone, IDF-free so the host suite checks
// it (sdmmc_card.cpp does the I/O). A recording is the directory `/sdcard/fr/<id 8 hex>` with its `meta.bin`; its
// frames are sharded into sub-directories of kShardFrames, `<index / 1000, 3 digits>/<index % 1000, 3 digits>.jpg`,
// so no FAT directory grows past a thousand entries (a FAT lookup is linear in the directory, and FatFs caps one at
// 65,534 entries). Every name is 8.3-safe: a build without long names (CONFIG_FATFS_LFN_NONE) reads and writes them
// the same; FatFs upper-cases them, so names are parsed case-insensitively.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace fr::drv::sdmmc_layout {

inline constexpr const char *kMount = "/sdcard";
inline constexpr const char *kRoot = "/sdcard/fr";
inline constexpr const char *kMetaName = "meta.bin";
/** Frames per shard directory. */
inline constexpr uint32_t kShardFrames = 1000;
/** Three shard digits: a recording holds at most this many frames (write_frame refuses the next). */
inline constexpr uint32_t kFramesMax = kShardFrames * 1000;
/** The longest path: "/sdcard/fr/" (11) + id (8) + "/" + shard (3) + "/" + "nnn.jpg" (7) + NUL = 32. */
inline constexpr size_t kPathMax = 48;
using Path = char[kPathMax];

inline constexpr uint32_t frame_shard(uint32_t index)
{
    return index / kShardFrames;
}
inline constexpr uint32_t frame_slot(uint32_t index)
{
    return index % kShardFrames;
}
inline constexpr uint32_t frame_index(uint32_t shard, uint32_t slot)
{
    return shard * kShardFrames + slot;
}

/** `/sdcard/fr/<id 8 hex>`. */
inline void dir_path(Path &out, uint32_t id)
{
    std::snprintf(out, sizeof(out), "%s/%08lx", kRoot, static_cast<unsigned long>(id));
}

/** `/sdcard/fr/<id 8 hex>/<shard 3 digits>`: the directory of frame `index`. */
inline void shard_path(Path &out, uint32_t id, uint32_t index)
{
    std::snprintf(out, sizeof(out), "%s/%08lx/%03lu", kRoot, static_cast<unsigned long>(id),
                  static_cast<unsigned long>(frame_shard(index)));
}

/** `/sdcard/fr/<id 8 hex>/<shard 3 digits>/<slot 3 digits>.jpg`. */
inline void frame_path(Path &out, uint32_t id, uint32_t index)
{
    std::snprintf(out, sizeof(out), "%s/%08lx/%03lu/%03lu.jpg", kRoot, static_cast<unsigned long>(id),
                  static_cast<unsigned long>(frame_shard(index)), static_cast<unsigned long>(frame_slot(index)));
}

/** `/sdcard/fr/<id 8 hex>/meta.bin`. */
inline void meta_path(Path &out, uint32_t id)
{
    std::snprintf(out, sizeof(out), "%s/%08lx/%s", kRoot, static_cast<unsigned long>(id), kMetaName);
}

/** A root entry that is a recording: eight hex digits (either case), nothing else. */
inline bool parse_id(const char *name, uint32_t &id)
{
    if (std::strlen(name) != 8) {
        return false;
    }
    for (int i = 0; i < 8; ++i) {
        const char c = name[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
            return false;
        }
    }
    id = static_cast<uint32_t>(std::strtoul(name, nullptr, 16));
    return true;
}

inline bool three_digits(const char *p, uint32_t &v)
{
    v = 0;
    for (int i = 0; i < 3; ++i) {
        if (p[i] < '0' || p[i] > '9') {
            return false;
        }
        v = v * 10 + static_cast<uint32_t>(p[i] - '0');
    }
    return true;
}

/** A recording entry that is a shard directory: three digits, nothing else. */
inline bool parse_shard(const char *name, uint32_t &shard)
{
    return std::strlen(name) == 3 && three_digits(name, shard);
}

/** A shard entry that is a frame: `<3 digits>.jpg` (FatFs may upper-case the extension); `slot` its digits. */
inline bool parse_frame(const char *name, uint32_t &slot)
{
    if (std::strlen(name) != 7 || !three_digits(name, slot)) {
        return false;
    }
    return name[3] == '.' && (name[4] == 'j' || name[4] == 'J') && (name[5] == 'p' || name[5] == 'P') &&
           (name[6] == 'g' || name[6] == 'G');
}

}  // namespace fr::drv::sdmmc_layout
