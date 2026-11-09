// L1 file store contract (design lcd-clock-c1 D5, D6): files on a removable FAT card, by path. StorageService (fr.storage)
// validates the paths and sizes; the driver (sdspi_card: esp_vfs_fat_sdspi_mount on the shared SPI bus) owns everything
// IDF-specific, the VFS prefix included: the service's paths are the card's, "/" its root.
//
// Threading: init() at board init (no mount). mount() and info() (the free-space walk) run on fr_worker; every other call
// on the core task, from command dispatch, one chunk (at most 1 KB) or one directory page at a time. StorageService
// never lets two run at once (its busy flag), so the driver needs no lock of its own.
//
// Errors: Err::not_found (no such path), Err::invalid_args (refused: exists, is a directory, read-only, full, a name
// too long, an offset past the end), Err::busy (out of memory or file handles: try again), Err::failed (the card's I/O
// failed). The service unmounts only for Err::failed when card_alive() says the card no longer answers.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/block_store.hpp"  // StoreState
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** fr.storage CardType (same values). */
enum class CardType : uint8_t { unknown = 0, sdsc = 1, sdhc = 2, sdxc = 3 };

struct CardInfo {
    CardType type = CardType::unknown;
    uint32_t total_mb = 0;
    uint32_t free_mb = 0;
    char name[9] = {};  // the CID's product name, NUL-terminated
    uint32_t speed_khz = 0;
};

struct FileEntry {
    char name[65] = {};  // NUL-terminated; a longer name is cut (the service still lists it)
    uint32_t size = 0;
    bool dir = false;
    uint32_t mtime = 0;  // unix s; 0 unknown
};

class FileStore
{
public:
    /** Pins and the bus only; no card access. */
    virtual Status init(Core &core) = 0;
    /** Mounts the card (FAT, no format): OK and mounted, Err::not_found with no card, Err::failed otherwise. */
    virtual Status mount(uint8_t max_files) = 0;
    /** Unmounts (no-op when not mounted). */
    virtual void unmount() = 0;
    virtual StoreState state() const = 0;
    /** The card's identity and sizes now (free space walks the FAT: tens of ms on a large card). */
    virtual Status info(CardInfo &out) = 0;
    /** Entries of directory `path` from the `offset`-th, into `out`; `more` when others follow. Err::not_found. */
    virtual std::expected<size_t, Err> list(const char *path, uint16_t offset, std::span<FileEntry> out, bool &more) = 0;
    virtual Status stat(const char *path, FileEntry &out) = 0;
    /** Up to out.size() bytes from `offset`; `eof` when the file ends within them (or before `offset`). */
    virtual std::expected<size_t, Err> read(const char *path, uint32_t offset, std::span<uint8_t> out, bool &eof) = 0;
    /**
     * `data` at `offset`, creating the file and its directories; `truncate` cuts the file at offset + data.size()
     * afterwards. The file's size after the write. An offset past the file's end is Err::invalid_args (FAT would leave
     * the gap undefined); a short write (the card full) is Err::invalid_args too.
     */
    virtual std::expected<uint32_t, Err> write(const char *path, uint32_t offset, std::span<const uint8_t> data,
                                               bool truncate) = 0;
    /** A file or an empty directory; Err::not_found, Err::busy for a directory that is not empty. */
    virtual Status remove(const char *path) = 0;
    /** OK when it exists already as a directory. */
    virtual Status mkdir(const char *path) = 0;
    virtual Status rename(const char *from, const char *to) = 0;
    /** The slot is removable (a card); a card-detect switch is wired. */
    virtual bool removable() const { return true; }
    virtual bool card_detect() const { return false; }
    /** The card still answers (a status command); false after it was pulled or died. */
    virtual bool card_alive() { return true; }
    virtual Selftest selftest() = 0;

protected:
    ~FileStore() = default;
};

}  // namespace fr::hal
