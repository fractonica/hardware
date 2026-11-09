// Persistence for a POSIX node (design uno-q-host §2.3): who it is (addr, net, alias, the hub's name) and its boot
// counter in one small text file, plus the directory and binding blobs Net keeps (nvs:fr_dir and nvs:fr_bind on
// target). Files are replaced atomically (write a temp file, fsync, rename), so a power cut leaves the old or the
// new one, never half of either.
#pragma once

#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <span>
#include <string>

#include "fr/core/node_net.hpp"
#include "fr/core/worker.hpp"

namespace fr::posix {

/** Writes `bytes` to `path` atomically; false on any error. */
bool write_file_atomic(const std::string &path, std::span<const uint8_t> bytes);
/** The whole file, or nullopt when it cannot be read. */
std::optional<std::string> read_file(const std::string &path);

/**
 * The node's identity file, `key=value` lines: addr, net, alias, alias_rev, epoch, hub (host[:port]). Unknown keys are
 * kept. epoch is the last boot's; begin_boot() raises it (RFC 1982 order, skipping 0) and commits it before the node
 * sends anything (spec 05 §5.5: a reused epoch has its frames dropped as duplicates).
 */
class IdentityFile
{
public:
    explicit IdentityFile(std::string path) : path_(std::move(path)) {}

    /** Reads the file (a missing one is an empty identity); false when it exists but cannot be read. */
    bool load();
    /** This boot's epoch, committed to disk: false when it could not be written (the node must not start then). */
    bool begin_boot(uint16_t floor = 1);
    bool save();

    uint16_t addr = 0xFFFE;  // proto::kAddrUnassigned
    uint16_t net = 0;
    std::string alias;
    uint32_t alias_rev = 0;
    uint16_t epoch = 0;
    std::string hub;  // host or host:port; empty: not provisioned

    const std::string &path() const { return path_; }

private:
    std::string path_;
    std::string extra_;  // lines with keys this version does not know, kept as they were
};

/** A blob in its own file (Net's directory and bindings). */
class FileBlob final : public core::Blob
{
public:
    explicit FileBlob(std::string path) : path_(std::move(path)) {}
    size_t read(std::span<uint8_t> out) override;
    bool write(std::span<const uint8_t> bytes) override;

private:
    std::string path_;
};

/** fr_worker on the Runner's thread: jobs run between core passes, one per loop turn. */
class InlineWorker final : public Worker
{
public:
    bool post(Callback<void(), 32> job) override;
    /** Runs one queued job; false when there was none. */
    bool run_one();
    bool idle() const;

private:
    mutable std::mutex mu_;
    std::deque<Callback<void(), 32>> jobs_;
};

}  // namespace fr::posix
