// Test doubles for the fr_ota core (design c4 §5): an image builder whose bytes carry the image header,
// esp_app_desc_t and fr_app_desc_t at their 06 §6.8 offsets; FakeFlash (a memory slot, otadata calls
// counted), FakeFetch (serves an image with Range, drops connections where told), FakeStore (nvs:fr_ota in
// memory), FakeOtaHost (frames to the hub, the endpoint, restarts) and OtaRig, which wires them to an Ota
// on FakeCore and FakeWorker. The fake slot reports the image's last 32 bytes as its SHA-256, as
// esp_partition_get_sha256 reports the appended digest once it verified it. Test code: it may allocate.
#pragma once

#include <algorithm>
#include <array>
#include <cstring>
#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "fr/net/net.hpp"
#include "fr/ota/check.hpp"
#include "fr/ota/ota.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "tests/fake_core.hpp"
#include "tests/fake_worker.hpp"
#include "tests/test.hpp"

namespace frt {

namespace ota = fr::ota;
namespace proto = fr::proto;

/** What an image claims about itself; the defaults pass CHECK on OtaRig's running image. */
struct ImageSpec {
    uint32_t size = 100'000;  // not a whole number of chunks
    uint16_t chip_id = 13;
    uint16_t min_rev = 0;
    uint16_t max_rev = 199;
    uint8_t magic = 0xE9;
    uint8_t hash_appended = 1;
    uint32_t esp_desc_magic = 0xABCD5432;
    uint32_t fr_magic = FR_APP_DESC_MAGIC;
    std::string version = "0.2.0+g1a2b3c4";
    std::string board = "esp32c6-supermini";
    std::string profile = "c6-pad";
    std::string part = "fr-4mb-v1";
    uint8_t fault = 0;
    uint8_t seed = 1;  // body bytes and the digest
};

inline void put_le16(std::vector<uint8_t> &b, size_t at, uint16_t v)
{
    b[at] = static_cast<uint8_t>(v);
    b[at + 1] = static_cast<uint8_t>(v >> 8);
}

inline void put_le32(std::vector<uint8_t> &b, size_t at, uint32_t v)
{
    for (size_t i = 0; i < 4; ++i) {
        b[at + i] = static_cast<uint8_t>(v >> (8 * i));
    }
}

inline void put_str(std::vector<uint8_t> &b, size_t at, size_t field, const std::string &s)
{
    std::memset(b.data() + at, 0, field);
    std::memcpy(b.data() + at, s.data(), std::min(s.size(), field));
}

/** The image as the hub would serve it: header, descriptors, a body from `seed`, and 32 "digest" bytes. */
inline std::vector<uint8_t> make_image(const ImageSpec &s = {})
{
    std::vector<uint8_t> b(s.size);
    for (size_t i = 0; i < b.size(); ++i) {
        b[i] = static_cast<uint8_t>(i * 31 + s.seed * 7 + (i >> 9));
    }
    b[0] = s.magic;
    put_le16(b, ota::kImageChipIdOffset, s.chip_id);
    b[14] = 0;
    put_le16(b, ota::kImageMinRevOffset, s.min_rev);
    put_le16(b, ota::kImageMaxRevOffset, s.max_rev);
    b[ota::kImageHashAppendedOffset] = s.hash_appended;
    put_le32(b, ota::kEspAppDescOffset, s.esp_desc_magic);
    put_str(b, ota::kEspAppVersionOffset, 32, s.version);
    const size_t d = ota::kAppDescOffset;
    put_le32(b, d, s.fr_magic);
    b[d + 4] = FR_APP_DESC_VERSION;
    put_str(b, d + offsetof(fr_app_desc_t, board), 32, s.board);
    put_str(b, d + offsetof(fr_app_desc_t, profile), 32, s.profile);
    put_str(b, d + offsetof(fr_app_desc_t, part_profile), 16, s.part);
    b[d + offsetof(fr_app_desc_t, fault)] = s.fault;
    for (size_t i = 0; i < 32; ++i) {
        b[b.size() - 32 + i] = static_cast<uint8_t>(0xA0 + s.seed + i);
    }
    return b;
}

inline std::array<uint8_t, 32> fw_of(const std::vector<uint8_t> &img)
{
    std::array<uint8_t, 32> fw{};
    std::copy(img.end() - 32, img.end(), fw.begin());
    return fw;
}

inline std::string hex_of(std::span<const uint8_t> b)
{
    static const char *digits = "0123456789abcdef";
    std::string s;
    for (uint8_t v : b) {
        s += digits[v >> 4];
        s += digits[v & 15];
    }
    return s;
}

class FakeFlash final : public ota::Flash
{
public:
    fr::Status begin(uint32_t size, uint32_t resume_off) override
    {
        begins.push_back({size, resume_off});
        if (fail_begin) {
            return std::unexpected(fr::Err::failed);
        }
        // esp_ota_begin starts from nothing; esp_ota_resume keeps what is before the offset.
        slot.resize(std::min<size_t>(slot.size(), resume_off));
        if (resume_off > 0 && slot.size() < resume_off) {
            slot.resize(resume_off, 0xFF);
        }
        open = true;
        return {};
    }
    fr::Status write(std::span<const uint8_t> bytes) override
    {
        writes.push_back(bytes.size());
        if (during_write) {
            during_write();
        }
        if (!open || (fail_write_after >= 0 && slot.size() + bytes.size() > static_cast<size_t>(fail_write_after))) {
            return std::unexpected(fr::Err::failed);
        }
        slot.insert(slot.end(), bytes.begin(), bytes.end());
        return {};
    }
    fr::Status finish(std::span<uint8_t, 32> sha_out) override
    {
        ++finishes;
        if (during_finish) {
            during_finish();
        }
        const bool was_open = open;
        open = false;
        if (!was_open) {
            return std::unexpected(fr::Err::failed);
        }
        if (finish_invalid || slot.size() < 32) {
            return std::unexpected(fr::Err::invalid_args);
        }
        if (finish_fails) {
            return std::unexpected(fr::Err::failed);
        }
        std::copy(slot.end() - 32, slot.end(), sha_out.begin());
        return {};
    }
    fr::Status set_boot() override
    {
        ++set_boots;
        if (during_set_boot) {
            during_set_boot();
        }
        if (fail_set_boot) {
            return std::unexpected(fr::Err::failed);
        }
        return {};
    }
    void abort() override
    {
        if (open) {
            ++aborts;
        }
        open = false;
    }
    fr::Status read(uint32_t offset, std::span<uint8_t> out) override
    {
        ++reads;
        if (offset + out.size() > slot.size()) {
            return std::unexpected(fr::Err::failed);
        }
        std::copy_n(slot.begin() + offset, out.size(), out.begin());
        return {};
    }
    fr::Status mark_valid() override
    {
        ++mark_valids;
        if (fail_mark_valid) {
            return std::unexpected(fr::Err::failed);
        }
        return {};
    }
    void rollback() override { ++rollbacks; }
    ota::RunningInfo running() const override { return info; }

    ota::RunningInfo info;
    std::vector<uint8_t> slot;  // the update slot: what has been written
    bool open = false;
    std::vector<std::pair<uint32_t, uint32_t>> begins;  // (size, resume_off)
    std::vector<size_t> writes;
    int finishes = 0;
    int set_boots = 0;
    int aborts = 0;
    int reads = 0;
    int mark_valids = 0;
    int rollbacks = 0;
    bool fail_begin = false;
    long fail_write_after = -1;  // a write that would take the slot past this many bytes fails
    bool finish_invalid = false;  // esp_ota_end: the image does not verify
    bool finish_fails = false;    // esp_ota_end: a flash error
    bool fail_set_boot = false;
    bool fail_mark_valid = false;
    // Run inside the call, on "fr_worker": what the core task does meanwhile (an ABORT arriving, say).
    std::function<void()> during_write;
    std::function<void()> during_finish;  // esp_ota_end and the partition hash: the image read in full
    std::function<void()> during_set_boot;
};

class FakeFetch final : public ota::Fetch
{
public:
    struct Start {
        std::string url;
        uint32_t from;
    };

    fr::Status start(const char *url, uint32_t from_byte) override
    {
        starts.push_back({url, from_byte});
        if (fail_starts > 0) {
            --fail_starts;
            return std::unexpected(fr::Err::failed);
        }
        if (from_byte > image.size()) {
            return std::unexpected(fr::Err::failed);
        }
        pos = from_byte;
        open = true;
        return {};
    }
    std::expected<size_t, fr::Err> read(std::span<uint8_t> out) override
    {
        ++reads;
        if (!open) {
            return std::unexpected(fr::Err::failed);
        }
        // A connection drop at an offset: the read that reaches it fails once.
        if (auto it = std::find(drops.begin(), drops.end(), pos); it != drops.end()) {
            drops.erase(it);
            open = false;
            return std::unexpected(fr::Err::failed);
        }
        size_t n = std::min({out.size(), max_read, image.size() - pos});
        for (size_t d : drops) {
            if (d > pos && d < pos + n) {
                n = d - pos;  // deliver up to the drop point, fail at the next read
            }
        }
        std::copy_n(image.begin() + static_cast<long>(pos), n, out.begin());
        pos += n;
        return n;
    }
    void close() override
    {
        ++closes;
        open = false;
    }

    std::vector<uint8_t> image;
    std::vector<Start> starts;
    std::vector<size_t> drops;  // offsets where the connection breaks (each once)
    size_t max_read = 1460;     // a TCP segment per read
    int fail_starts = 0;        // the next N starts fail (connection refused, 404)
    size_t pos = 0;
    bool open = false;
    int reads = 0;
    int closes = 0;
};

class FakeStore final : public ota::Store
{
public:
    bool load(ota::Record &out) override
    {
        ++loads;
        if (!rec) {
            return false;
        }
        out = *rec;
        return true;
    }
    fr::Status save(const ota::Record &r) override
    {
        ++saves;
        rec = r;
        if (after_save) {
            after_save(r);
        }
        return {};
    }
    fr::Status save_off(uint32_t off) override
    {
        offs.push_back(off);
        if (rec) {
            rec->off = off;
        }
        return {};
    }
    fr::Status save_state(ota::RecState s) override
    {
        states.push_back(s);
        if (rec) {
            rec->state = s;
        }
        return {};
    }
    fr::Status clear() override
    {
        ++clears;
        rec.reset();
        return {};
    }

    std::optional<ota::Record> rec;
    std::function<void(const ota::Record &)> after_save;  // on "fr_worker", once the record is stored
    std::vector<uint32_t> offs;
    std::vector<ota::RecState> states;
    int loads = 0;
    int saves = 0;
    int clears = 0;
};

class FakeOtaHost final : public ota::Host
{
public:
    struct Sent {
        uint8_t kind;
        std::vector<uint8_t> body;
        bool ack_req;
        fr::TimeUs at;
    };

    explicit FakeOtaHost(const fr::Core &core) : core_(core) {}

    fr::Status send(uint8_t kind, std::span<const uint8_t> body, bool ack_req) override
    {
        if (!session) {
            ++refused;
            return std::unexpected(fr::Err::busy);
        }
        sent.push_back({kind, {body.begin(), body.end()}, ack_req, core_.now()});
        return {};
    }
    bool endpoint(ota::Endpoint &out) override
    {
        if (!has_endpoint) {
            return false;
        }
        out = ep;
        return true;
    }
    void restart() override { ++restarts; }

    std::vector<Sent> of(uint8_t kind) const
    {
        std::vector<Sent> out;
        for (const Sent &s : sent) {
            if (s.kind == kind) {
                out.push_back(s);
            }
        }
        return out;
    }
    size_t count(uint8_t kind) const { return of(kind).size(); }

    std::vector<Sent> sent;
    bool session = true;
    bool has_endpoint = true;
    ota::Endpoint ep{"192.168.0.17", 7422};
    int restarts = 0;
    int refused = 0;

private:
    const fr::Core &core_;
};

// Decoded node -> hub bodies (copies: the decoders' views die with their input).
struct Answer {
    std::string job;
    uint8_t code;
};
struct StatusMsg {
    std::string job;
    uint8_t state;
    uint32_t bytes;
};
struct ResultMsg {
    std::string job;
    uint8_t outcome;
    std::vector<uint8_t> prefix;
    uint8_t reason;
};

inline Answer answer_of(uint8_t kind, std::span<const uint8_t> body)
{
    if (kind == proto::kKindOtaAccept) {
        auto a = proto::decode_ota_accept(body);
        CHECK(a.has_value());
        return a ? Answer{std::string(a->job_id), a->code} : Answer{};
    }
    auto r = proto::decode_ota_reject(body);
    CHECK(r.has_value());
    return r ? Answer{std::string(r->job_id), r->code} : Answer{};
}

inline StatusMsg status_of(std::span<const uint8_t> body)
{
    auto s = proto::decode_ota_status(body);
    CHECK(s.has_value());
    return s ? StatusMsg{std::string(s->job_id), s->state, s->bytes} : StatusMsg{};
}

inline ResultMsg result_of(std::span<const uint8_t> body)
{
    auto r = proto::decode_ota_result(body);
    CHECK(r.has_value());
    return r ? ResultMsg{std::string(r->job_id), r->outcome, {r->fw_id_prefix.begin(), r->fw_id_prefix.end()}, r->reason}
             : ResultMsg{};
}

/** The running image every rig starts from: c6-pad 0.1.0 in ota_0, the update slot ota_1 of fr-4mb-v1. */
inline ota::RunningInfo default_running()
{
    ota::RunningInfo r;
    r.fw_id.fill(0x11);
    std::snprintf(r.version, sizeof(r.version), "%s", "0.1.0+g0000000");
    r.chip_id = 13;
    r.chip_rev = 1;  // v0.1
    r.slot_size = 0x1E0000;
    r.slot_addr = 0x1F0000;
    return r;
}

inline ota::Ident default_ident()
{
    ota::Ident id;
    std::snprintf(id.board, sizeof(id.board), "%s", "esp32c6-supermini");
    std::snprintf(id.profile, sizeof(id.profile), "%s", "c6-pad");
    std::snprintf(id.part_profile, sizeof(id.part_profile), "%s", "fr-4mb-v1");
    return id;
}

template <class Msg>
std::vector<uint8_t> body_of(const Msg &m)
{
    std::vector<uint8_t> out(Msg::kMaxSize);
    fr::wire::Writer w(out);
    encode(m, w);
    out.resize(w.size());
    return out;
}

/** Ota on FakeCore and FakeWorker over the fakes above; boot() binds it and runs on_boot(). */
struct OtaRig {
    OtaRig() : host(core)
    {
        flash.info = default_running();
        deps.core = &core;
        deps.worker = &worker;
        deps.flash = &flash;
        deps.fetch = &fetch;
        deps.store = &store;
        deps.host = &host;
        deps.ident = default_ident();
    }

    void boot()
    {
        REQUIRE(ota.bind(deps));
        ota.on_boot();
        core.run_ready();
    }

    /** Serves `img` and offers it (fw_id: the image's digest unless given); returns the immediate answer. */
    fr::net::OtaReply offer(const std::vector<uint8_t> &img, uint32_t flags = 0, const std::string &job = "ota-1",
                            std::optional<std::array<uint8_t, 32>> fw = std::nullopt,
                            std::optional<uint32_t> size = std::nullopt)
    {
        fetch.image = img;
        const std::array<uint8_t, 32> id = fw ? *fw : fw_of(img);
        const auto body = body_of(proto::OtaOffer{.job_id = job,
                                                  .fw_id = id,
                                                  .size = size ? *size : static_cast<uint32_t>(img.size()),
                                                  .version = "0.2.0",
                                                  .flags = flags});
        return frame(proto::kKindOtaOffer, body);
    }

    fr::net::OtaReply frame(uint8_t kind, const std::vector<uint8_t> &body)
    {
        fr::net::OtaReply reply;
        ota.on_frame(kind, body, reply);
        core.run_ready();
        return reply;
    }

    void commit(const std::string &job = "ota-1") { frame(proto::kKindOtaCommit, body_of(proto::OtaCommit{.job_id = job})); }
    void abort(const std::string &job = "ota-1") { frame(proto::kKindOtaAbort, body_of(proto::OtaAbort{.job_id = job})); }

    /** Runs fr_worker's jobs and the core task until neither has anything left (the clock stands still). */
    void settle()
    {
        for (int guard = 0; guard < 100000; ++guard) {
            core.run_ready();
            if (!worker.run_one()) {
                core.run_ready();
                return;
            }
        }
        fail(__FILE__, __LINE__, "OtaRig: worker never settles");
    }

    /** One worker job, then whatever it posted to the core task. */
    bool step()
    {
        const bool ran = worker.run_one();
        core.run_ready();
        return ran;
    }

    std::vector<Answer> answers(uint8_t kind) const
    {
        std::vector<Answer> out;
        for (const auto &s : host.of(kind)) {
            out.push_back(answer_of(kind, s.body));
        }
        return out;
    }
    std::vector<StatusMsg> statuses() const
    {
        std::vector<StatusMsg> out;
        for (const auto &s : host.of(proto::kKindOtaStatus)) {
            out.push_back(status_of(s.body));
        }
        return out;
    }
    std::vector<ResultMsg> results() const
    {
        std::vector<ResultMsg> out;
        for (const auto &s : host.of(proto::kKindOtaResult)) {
            out.push_back(result_of(s.body));
        }
        return out;
    }

    FakeCore core;
    FakeWorker worker;
    FakeFlash flash;
    FakeFetch fetch;
    FakeStore store;
    FakeOtaHost host;
    ota::Deps deps;
    ota::Ota ota;
};

inline Answer reply_answer(const fr::net::OtaReply &r)
{
    return answer_of(r.kind(), r.body());
}

}  // namespace frt
