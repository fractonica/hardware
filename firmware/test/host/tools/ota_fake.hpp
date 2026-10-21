// fr_net_node's OTA sink (design c4 §5): what fr_ota/src/esp is on target, on the host, so the real
// fr::ota::Ota runs against a real hub on loopback. A memory flash that verifies the appended SHA-256 like
// esp_ota_end, the board's HTTP/1.1 GET with Range (fr::ota::HttpGet, on POSIX sockets here) against the
// hub's node HTTP port, nvs:fr_ota, fr_worker as a queue the main loop drains, and the bootloader's otadata
// rules across process restarts.
//
// With --ota-dir the state survives the process, as flash survives a reboot: `boot.txt` (running image,
// PENDING_VERIFY, the previous and the last invalid image, the boot partition set by an OTA), `slot.bin`
// (the update slot, appended as written, truncated on a resume) and `rec.txt` (nvs:fr_ota). Each start
// first does what the bootloader would: an image set as the boot partition starts PENDING_VERIFY, and a
// PENDING_VERIFY image that ended without being marked valid is marked aborted and the previous one runs.
// Without --ota-dir everything lives in memory for one process. Test code: it may allocate.
#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "fr/core/worker.hpp"
#include "fr/ota/check.hpp"
#include "fr/ota/http_get.hpp"
#include "fr/ota/ota.hpp"

namespace ota_fake {

void emit(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

using Digest = std::array<uint8_t, 32>;

// ---- SHA-256 (FIPS 180-4): what esp_ota_end and esp_partition_get_sha256 check the appended digest with ----

class Sha256
{
public:
    void update(const uint8_t *p, size_t n)
    {
        for (size_t i = 0; i < n; ++i) {
            buf_[len_++] = p[i];
            if (len_ == 64) {
                block(buf_);
                len_ = 0;
            }
        }
        bits_ += static_cast<uint64_t>(n) * 8;
    }
    Digest finish()
    {
        const uint64_t bits = bits_;
        const uint8_t one = 0x80;
        update(&one, 1);
        const uint8_t zero = 0;
        while (len_ != 56) {
            update(&zero, 1);
        }
        uint8_t len[8];
        for (int i = 0; i < 8; ++i) {
            len[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
        }
        update(len, 8);
        Digest d{};
        for (int i = 0; i < 8; ++i) {
            for (int j = 0; j < 4; ++j) {
                d[static_cast<size_t>(4 * i + j)] = static_cast<uint8_t>(h_[i] >> (24 - 8 * j));
            }
        }
        return d;
    }
    static Digest of(const uint8_t *p, size_t n)
    {
        Sha256 s;
        s.update(p, n);
        return s.finish();
    }

private:
    static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
    void block(const uint8_t *b)
    {
        static constexpr uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
            w[i] = static_cast<uint32_t>(b[4 * i]) << 24 | static_cast<uint32_t>(b[4 * i + 1]) << 16 |
                   static_cast<uint32_t>(b[4 * i + 2]) << 8 | b[4 * i + 3];
        }
        for (int i = 16; i < 64; ++i) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h_[0], bb = h_[1], c = h_[2], d = h_[3], e = h_[4], f = h_[5], g = h_[6], h = h_[7];
        for (int i = 0; i < 64; ++i) {
            const uint32_t t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
            const uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c));
            h = g;
            g = f;
            f = e;
            e = d + t1;
            d = c;
            c = bb;
            bb = a;
            a = t1 + t2;
        }
        h_[0] += a;
        h_[1] += bb;
        h_[2] += c;
        h_[3] += d;
        h_[4] += e;
        h_[5] += f;
        h_[6] += g;
        h_[7] += h;
    }

    uint32_t h_[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    uint8_t buf_[64] = {};
    size_t len_ = 0;
    uint64_t bits_ = 0;
};

inline std::string hex(std::span<const uint8_t> b)
{
    static const char *digits = "0123456789abcdef";
    std::string s;
    for (uint8_t v : b) {
        s += digits[v >> 4];
        s += digits[v & 15];
    }
    return s;
}

inline bool unhex(std::string_view s, std::span<uint8_t> out)
{
    if (s.size() != out.size() * 2) {
        return false;
    }
    for (size_t i = 0; i < out.size(); ++i) {
        char byte[3] = {s[2 * i], s[2 * i + 1], 0};
        char *end = nullptr;
        out[i] = static_cast<uint8_t>(std::strtoul(byte, &end, 16));
        if (end != byte + 2) {
            return false;
        }
    }
    return true;
}

// ---- a fake app image: what `fr_net_node --make-image` writes for interop tests ----

struct ImageOptions {
    uint32_t size = 200'000;
    std::string version = "0.2.0";
    std::string board = "esp32c6-supermini";
    std::string profile = "c6-pad";
    std::string part = "fr-4mb-v1";
    uint16_t chip = 13;
    uint16_t min_rev = 0;
    uint16_t max_rev = 199;
    uint8_t fault = 0;
    uint32_t seed = 1;
};

/** An image CHECK accepts on fr_net_node (06 §6.8 offsets) whose last 32 bytes are the SHA-256 of the rest. */
inline std::vector<uint8_t> make_image(const ImageOptions &o)
{
    std::vector<uint8_t> b(std::max<uint32_t>(o.size, fr::ota::kCheckBytes + 32));
    uint32_t x = o.seed * 2654435761u + 1;
    for (uint8_t &v : b) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        v = static_cast<uint8_t>(x);
    }
    auto le16 = [&b](size_t at, uint16_t v) {
        b[at] = static_cast<uint8_t>(v);
        b[at + 1] = static_cast<uint8_t>(v >> 8);
    };
    auto le32 = [&b](size_t at, uint32_t v) {
        for (size_t i = 0; i < 4; ++i) {
            b[at + i] = static_cast<uint8_t>(v >> (8 * i));
        }
    };
    auto str = [&b](size_t at, size_t field, const std::string &s) {
        std::memset(b.data() + at, 0, field);
        std::memcpy(b.data() + at, s.data(), std::min(s.size(), field - 1));
    };
    b[0] = fr::ota::kImageMagic;
    // One segment from offset 24 whose padded end (checksum block) is where the digest starts when the
    // size allows, so the hub's ingest parser (artifacts.ts parseAppImage) walks it like an IDF image; the
    // esp_app_desc_t and fr_app_desc sit in its data, as in segment 0 of a real build.
    b[1] = 1;
    const uint32_t body = (static_cast<uint32_t>(b.size()) - 32) & ~15u;
    le32(24, 0x420e0020u);
    le32(28, body - 48);
    le16(fr::ota::kImageChipIdOffset, o.chip);
    le16(fr::ota::kImageMinRevOffset, o.min_rev);
    le16(fr::ota::kImageMaxRevOffset, o.max_rev);
    b[fr::ota::kImageHashAppendedOffset] = 1;
    le32(fr::ota::kEspAppDescOffset, fr::ota::kEspAppDescMagic);
    str(fr::ota::kEspAppVersionOffset, 32, o.version);
    const size_t d = fr::ota::kAppDescOffset;
    std::memset(b.data() + d, 0, sizeof(fr_app_desc_t));
    le32(d, FR_APP_DESC_MAGIC);
    b[d + 4] = FR_APP_DESC_VERSION;
    str(d + offsetof(fr_app_desc_t, board), 32, o.board);
    str(d + offsetof(fr_app_desc_t, profile), 32, o.profile);
    str(d + offsetof(fr_app_desc_t, part_profile), 16, o.part);
    b[d + offsetof(fr_app_desc_t, fault)] = o.fault;
    const Digest sha = Sha256::of(b.data(), b.size() - 32);
    std::copy(sha.begin(), sha.end(), b.end() - 32);
    return b;
}

// ---- fr_worker: a FIFO the main loop drains one job per round ----

class HostWorker final : public fr::Worker
{
public:
    bool post(fr::Callback<void(), 32> job) override
    {
        if (jobs_.size() >= fr::worker::kQueueDepth) {
            return false;
        }
        jobs_.push_back(std::move(job));
        return true;
    }
    bool run_one()
    {
        if (jobs_.empty()) {
            return false;
        }
        fr::Callback<void(), 32> job = std::move(jobs_.front());
        jobs_.pop_front();
        job();
        return true;
    }
    bool idle() const { return jobs_.empty(); }

private:
    std::deque<fr::Callback<void(), 32>> jobs_;
};

// ---- files ----

inline std::optional<std::string> read_file(const std::string &path)
{
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        return std::nullopt;
    }
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

inline void write_file(const std::string &path, std::string_view data)
{
    const std::string tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        f.write(data.data(), static_cast<std::streamsize>(data.size()));
    }
    std::rename(tmp.c_str(), path.c_str());  // whole or not at all, like an NVS commit
}

/** `key=value` lines. */
inline std::string kv(std::string_view text, std::string_view key)
{
    std::string_view rest = text;
    while (!rest.empty()) {
        const size_t nl = rest.find('\n');
        const std::string_view line = rest.substr(0, nl);
        rest = nl == std::string_view::npos ? std::string_view{} : rest.substr(nl + 1);
        if (line.size() > key.size() && line.starts_with(key) && line[key.size()] == '=') {
            return std::string(line.substr(key.size() + 1));
        }
    }
    return {};
}

// ---- the flash: two slots, otadata, the bootloader's choice at each start ----

struct BootState {
    Digest running{};
    std::string version;
    bool fault = false;  // the running image is a fault build (its fr_app_desc says so)
    bool pending = false;
    std::optional<Digest> prev;  // what a rollback boots
    std::string prev_version;
    bool prev_fault = false;
    std::optional<Digest> last_invalid;
    std::optional<Digest> next;  // the boot partition an OTA set
    std::string next_version;
    bool next_fault = false;
    uint8_t slot = 0;  // running slot: 0 ota_0 (update slot ota_1 at 0x1F0000), 1 ota_1
    bool crashed = false;  // the previous process ended in `crash` (a panic)
};

class MemFlash final : public fr::ota::Flash
{
public:
    /** Loads the state (or starts from `running`/`version`) and does what the bootloader does at a reset. */
    MemFlash(std::string dir, const Digest &running, const std::string &version) : dir_(std::move(dir))
    {
        s_.running = running;
        s_.version = version;
        if (!dir_.empty()) {
            if (auto t = read_file(dir_ + "/boot.txt")) {
                load(*t);
            }
            if (auto slot = read_file(dir_ + "/slot.bin")) {
                slot_.assign(slot->begin(), slot->end());
            }
        }
        crashed_ = s_.crashed;
        s_.crashed = false;
        if (s_.next) {
            // ota_data names the new slot: it boots, ESP_OTA_IMG_NEW -> PENDING_VERIFY.
            s_.prev = s_.running;
            s_.prev_version = s_.version;
            s_.prev_fault = s_.fault;
            s_.running = *s_.next;
            s_.version = s_.next_version;
            s_.fault = s_.next_fault;
            s_.next.reset();
            s_.pending = true;
            s_.slot ^= 1;
            slot_.clear();  // the update slot is now the old image's
            emit(R"({"ev":"ota_boot","fw":"%s","pending":true})", hex(s_.running).c_str());
        } else if (s_.pending && s_.prev) {
            // A PENDING_VERIFY image reset before it was marked valid: ABORTED, the previous one boots.
            rollback_state();
            emit(R"({"ev":"ota_boot","fw":"%s","rolled_back":true,"crashed":%s})", hex(s_.running).c_str(),
                 crashed_ ? "true" : "false");
        }
        save();
    }

    fr::Status begin(uint32_t, uint32_t resume_off) override
    {
        if (resume_off > slot_.size()) {
            return std::unexpected(fr::Err::failed);
        }
        slot_.resize(resume_off);
        // esp_ota_begin invalidates the inactive slot's otadata entry; a resume keeps it as it was.
        if (resume_off == 0) {
            s_.last_invalid.reset();
            save();
        }
        persist_slot();
        open_ = true;
        return {};
    }
    fr::Status write(std::span<const uint8_t> bytes) override
    {
        if (!open_) {
            return std::unexpected(fr::Err::failed);
        }
        slot_.insert(slot_.end(), bytes.begin(), bytes.end());
        if (!dir_.empty()) {
            std::ofstream f(dir_ + "/slot.bin", std::ios::binary | std::ios::app);
            f.write(reinterpret_cast<const char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        }
        return {};
    }
    fr::Status finish(std::span<uint8_t, 32> sha_out) override
    {
        if (!open_) {
            return std::unexpected(fr::Err::failed);
        }
        open_ = false;
        if (slot_.size() < fr::ota::kCheckBytes + 32) {
            return std::unexpected(fr::Err::invalid_args);
        }
        Digest appended{};
        std::copy(slot_.end() - 32, slot_.end(), appended.begin());
        if (Sha256::of(slot_.data(), slot_.size() - 32) != appended) {
            return std::unexpected(fr::Err::invalid_args);  // esp_ota_end: ESP_ERR_OTA_VALIDATE_FAILED
        }
        std::copy(appended.begin(), appended.end(), sha_out.begin());
        staged_ = appended;
        const char *v = reinterpret_cast<const char *>(slot_.data() + fr::ota::kEspAppVersionOffset);
        staged_version_.assign(v, strnlen(v, 32));
        staged_fault_ = slot_[fr::ota::kAppDescOffset + offsetof(fr_app_desc_t, fault)] == FR_APP_DESC_FAULT_HEALTH;
        return {};
    }
    fr::Status set_boot() override
    {
        if (!staged_) {
            return std::unexpected(fr::Err::failed);
        }
        s_.next = staged_;
        s_.next_version = staged_version_;
        s_.next_fault = staged_fault_;
        save();
        return {};
    }
    void abort() override { open_ = false; }
    fr::Status read(uint32_t offset, std::span<uint8_t> out) override
    {
        if (offset + out.size() > slot_.size()) {
            return std::unexpected(fr::Err::failed);
        }
        std::copy_n(slot_.begin() + offset, out.size(), out.begin());
        return {};
    }
    fr::Status mark_valid() override
    {
        s_.pending = false;
        save();
        emit(R"({"ev":"ota_valid","fw":"%s"})", hex(s_.running).c_str());
        return {};
    }
    void rollback() override
    {
        if (!s_.prev) {
            emit(R"({"ev":"ota_rollback_impossible"})");
            return;  // as esp_ota_mark_app_invalid_rollback_and_reboot without another app
        }
        const Digest invalid = s_.running;
        rollback_state();
        save();
        emit(R"({"ev":"ota_rollback","invalid":"%s"})", hex(invalid).c_str());
        reboot_requested = true;
    }
    fr::ota::RunningInfo running() const override
    {
        fr::ota::RunningInfo r;
        r.fw_id = s_.running;
        std::snprintf(r.version, sizeof(r.version), "%s", s_.version.c_str());
        r.pending_verify = s_.pending;
        if (s_.last_invalid) {
            r.has_last_invalid = true;
            r.last_invalid_fw_id = *s_.last_invalid;
        }
        r.chip_id = 13;
        r.chip_rev = 1;
        r.slot_size = 0x1E0000;
        r.slot_addr = s_.slot == 0 ? 0x1F0000 : 0x10000;
        r.crashed = crashed_;
        return r;
    }

    const BootState &state() const { return s_; }
    /** `crash`: the process ends like a panic; the next start sees it in its reset reason. */
    void note_crash()
    {
        s_.crashed = true;
        save();
    }

    bool reboot_requested = false;  // rollback(): the main loop restarts (exits)

private:
    void rollback_state()
    {
        s_.last_invalid = s_.running;
        s_.running = *s_.prev;
        s_.version = s_.prev_version;
        s_.fault = s_.prev_fault;
        s_.prev.reset();
        s_.pending = false;
        s_.slot ^= 1;
    }
    void load(const std::string &t)
    {
        auto digest = [&t](const char *key) -> std::optional<Digest> {
            Digest d{};
            const std::string v = kv(t, key);
            if (!unhex(v, d)) {
                return std::nullopt;
            }
            return d;
        };
        if (auto d = digest("running")) {
            s_.running = *d;
            s_.version = kv(t, "version");
            s_.fault = kv(t, "fault") == "1";
        }
        s_.pending = kv(t, "pending") == "1";
        s_.prev = digest("prev");
        s_.prev_version = kv(t, "prev_version");
        s_.prev_fault = kv(t, "prev_fault") == "1";
        s_.last_invalid = digest("last_invalid");
        s_.next = digest("next");
        s_.next_version = kv(t, "next_version");
        s_.next_fault = kv(t, "next_fault") == "1";
        s_.slot = kv(t, "slot") == "1" ? 1 : 0;
        s_.crashed = kv(t, "crashed") == "1";
    }
    void save() const
    {
        if (dir_.empty()) {
            return;
        }
        auto d = [](const std::optional<Digest> &v) { return v ? hex(*v) : std::string("-"); };
        auto b = [](bool v) { return std::string(v ? "1" : "0"); };
        std::string t = "running=" + hex(s_.running) + "\nversion=" + s_.version + "\nfault=" + b(s_.fault) +
                        "\npending=" + b(s_.pending) + "\nprev=" + d(s_.prev) + "\nprev_version=" + s_.prev_version +
                        "\nprev_fault=" + b(s_.prev_fault) + "\nlast_invalid=" + d(s_.last_invalid) + "\nnext=" + d(s_.next) +
                        "\nnext_version=" + s_.next_version + "\nnext_fault=" + b(s_.next_fault) + "\nslot=" + b(s_.slot != 0) +
                        "\ncrashed=" + b(s_.crashed) + "\n";
        write_file(dir_ + "/boot.txt", t);
    }
    void persist_slot() const
    {
        if (!dir_.empty()) {
            write_file(dir_ + "/slot.bin", std::string_view(reinterpret_cast<const char *>(slot_.data()), slot_.size()));
        }
    }

    std::string dir_;
    BootState s_;
    bool crashed_ = false;
    std::vector<uint8_t> slot_;
    bool open_ = false;
    std::optional<Digest> staged_;
    std::string staged_version_;
    bool staged_fault_ = false;
};

// ---- nvs:fr_ota ----

class MemStore final : public fr::ota::Store
{
public:
    explicit MemStore(std::string dir) : dir_(std::move(dir))
    {
        if (dir_.empty()) {
            return;
        }
        const auto t = read_file(dir_ + "/rec.txt");
        fr::ota::Record r;
        if (!t || !unhex(kv(*t, "fw"), r.fw_id)) {
            return;
        }
        std::snprintf(r.job_id, sizeof(r.job_id), "%s", kv(*t, "job").c_str());
        r.size = static_cast<uint32_t>(std::strtoul(kv(*t, "size").c_str(), nullptr, 10));
        r.off = static_cast<uint32_t>(std::strtoul(kv(*t, "off").c_str(), nullptr, 10));
        r.slot = static_cast<uint32_t>(std::strtoul(kv(*t, "slot").c_str(), nullptr, 10));
        r.hub_seen = kv(*t, "hub_seen") == "1";
        r.state = static_cast<fr::ota::RecState>(std::strtoul(kv(*t, "state").c_str(), nullptr, 10));
        rec_ = r;
    }

    bool load(fr::ota::Record &out) override
    {
        if (!rec_) {
            return false;
        }
        out = *rec_;
        return true;
    }
    fr::Status save(const fr::ota::Record &r) override
    {
        rec_ = r;
        persist();
        return {};
    }
    fr::Status save_off(uint32_t off) override
    {
        if (rec_) {
            rec_->off = off;
            persist();
        }
        return {};
    }
    fr::Status save_state(fr::ota::RecState s) override
    {
        if (rec_) {
            rec_->state = s;
            persist();
        }
        return {};
    }
    fr::Status clear() override
    {
        rec_.reset();
        if (!dir_.empty()) {
            std::remove((dir_ + "/rec.txt").c_str());
        }
        return {};
    }

private:
    void persist() const
    {
        if (dir_.empty() || !rec_) {
            return;
        }
        const fr::ota::Record &r = *rec_;
        const std::string t = "job=" + std::string(r.job_id, strnlen(r.job_id, sizeof(r.job_id))) + "\nfw=" + hex(r.fw_id) +
                              "\nsize=" + std::to_string(r.size) + "\noff=" + std::to_string(r.off) +
                              "\nslot=" + std::to_string(r.slot) + "\nhub_seen=" + (r.hub_seen ? "1" : "0") +
                              "\nstate=" + std::to_string(static_cast<unsigned>(r.state)) + "\n";
        write_file(dir_ + "/rec.txt", t);
    }

    std::string dir_;
    std::optional<fr::ota::Record> rec_;
};

// ---- the image download: the board's own GET (fr_ota/src/http) on POSIX sockets, a 5 s timeout ----

/** fr::ota::HttpGet with one `ota_get` line per GET (its Range start and the status, 0 when none came). The
 * timeout is shorter than the board's 10 s: this node's worker runs on its one loop. */
class HttpFetch final : public fr::ota::Fetch
{
public:
    fr::Status start(const char *url, uint32_t from_byte) override
    {
        const fr::Status st = http_.start(url, from_byte);
        if (st) {
            emit(R"({"ev":"ota_get","from":%u,"status":%d})", from_byte, http_.status());
        } else {
            emit(R"({"ev":"ota_get","from":%u,"status":%d,"error":"%s"})", from_byte, http_.status(), http_.error());
        }
        return st;
    }
    std::expected<size_t, fr::Err> read(std::span<uint8_t> out) override { return http_.read(out); }
    void close() override { http_.close(); }

private:
    fr::ota::HttpGet http_{5000};
};

}  // namespace ota_fake
