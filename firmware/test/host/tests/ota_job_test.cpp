// The node's OTA job (design c4 §3, spec 06 §6.6) on fake Flash/Fetch/Store: OFFER answers (every REJECT
// code, sync or after the image's first bytes), the download on fr_worker (4 KB chunks, Range re-issues,
// the resume point every 64 KB, resume after a reboot with CHECK on the read-back descriptors), VERIFY,
// DEFER_COMMIT/COMMIT, ABORT (and the ABORTs that race fr_worker: a re-OFFER while aborting, an end the
// worker reached first, the verify and the last check before set_boot), STATUS cadence and the hand-over
// to the restart.
#include "tests/ota_fakes.hpp"

namespace {

using frt::ImageSpec;
using frt::make_image;
using frt::fw_of;
using frt::OtaRig;
namespace ota = fr::ota;
namespace proto = fr::proto;

constexpr uint8_t kAccept = proto::kKindOtaAccept;
constexpr uint8_t kReject = proto::kKindOtaReject;

uint8_t code(ota::Reject r)
{
    return static_cast<uint8_t>(r);
}

/** Runs worker steps until the ACCEPT is out (or `limit` steps). */
void until_accepted(OtaRig &r, int limit = 20)
{
    for (int i = 0; i < limit && r.host.count(kAccept) == 0; ++i) {
        r.step();
    }
}

}  // namespace

TEST(ota_job_fresh_download_installs_and_restarts)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({});
    auto reply = r.offer(img);
    CHECK(!reply.has());  // the ACCEPT waits for the image's first bytes
    CHECK(r.ota.busy());
    // prepare, connect, head: CHECK before the first flash write.
    r.step();
    r.step();
    CHECK(r.flash.begins.empty());
    CHECK_EQ(r.host.count(kAccept), 0u);
    r.step();
    CHECK_EQ(r.flash.begins.size(), 1u);
    CHECK_EQ(r.host.count(kAccept), 1u);
    r.settle();

    const auto acc = r.answers(kAccept);
    REQUIRE_EQ(acc.size(), 1u);
    CHECK_EQ(acc[0].job, "ota-1");
    CHECK_EQ(acc[0].code, static_cast<uint8_t>(ota::Accept::fresh));
    CHECK_EQ(r.host.sent.front().kind, kAccept);
    CHECK(!r.host.sent.front().ack_req);  // the OFFER's acknowledgement (05 §5.8), not itself acknowledged
    CHECK_EQ(r.host.count(kReject), 0u);
    // The slot holds the image as served, written in whole 4 KB chunks but the last.
    CHECK(r.flash.slot == img);
    REQUIRE_EQ(r.flash.begins.size(), 1u);
    CHECK_EQ(r.flash.begins[0].first, img.size());
    CHECK_EQ(r.flash.begins[0].second, 0u);
    for (size_t i = 0; i + 1 < r.flash.writes.size(); ++i) {
        CHECK_EQ(r.flash.writes[i], ota::kChunk);
    }
    CHECK_EQ(r.flash.writes.back(), img.size() % ota::kChunk);
    // design c4 §3: the session's hub address, 7422, the lowercase hex fw_id.
    REQUIRE_EQ(r.fetch.starts.size(), 1u);
    CHECK_EQ(r.fetch.starts[0].url, "http://192.168.0.17:7422/ota/" + frt::hex_of(fw_of(img)) + ".bin");
    CHECK_EQ(r.fetch.starts[0].from, 0u);
    CHECK(!r.fetch.open);
    // VERIFY passed: the boot partition, STATUS rebooting with every byte, then the restart (BYE ota).
    CHECK_EQ(r.flash.finishes, 1);
    CHECK_EQ(r.flash.set_boots, 1);
    CHECK_EQ(r.host.restarts, 1);
    const auto st = r.statuses();
    REQUIRE(!st.empty());
    CHECK_EQ(st.back().state, static_cast<uint8_t>(ota::Phase::rebooting));
    CHECK_EQ(st.back().bytes, img.size());
    CHECK(r.results().empty());  // the RESULT comes from the new image after its health gate
    // nvs:fr_ota names the job for the next boot: installed, no resume point.
    REQUIRE(r.store.rec.has_value());
    CHECK_EQ(std::string_view(r.store.rec->job_id), "ota-1");
    CHECK(r.store.rec->fw_id == fw_of(img));
    CHECK_EQ(r.store.rec->size, img.size());
    CHECK_EQ(r.store.rec->off, 0u);
    CHECK_EQ(r.store.rec->slot, 0x1F0000u);
    CHECK(r.store.rec->hub_seen);
    CHECK(r.store.rec->state == ota::RecState::installed);
    CHECK(r.ota.busy());  // until the restart
}

TEST(ota_job_status_every_5_percent)
{
    OtaRig r;
    r.boot();
    r.fetch.max_read = 1000;
    const auto img = make_image({.size = 200'000});
    r.offer(img);
    r.settle();
    std::vector<uint32_t> bytes;
    for (const auto &s : r.statuses()) {
        if (s.state == static_cast<uint8_t>(ota::Phase::downloading)) {
            bytes.push_back(s.bytes);
        }
    }
    // The clock stood still, so only progress triggered them: one per 5 % (10 000 B), not one per read.
    CHECK(bytes.size() >= 15u);
    CHECK(bytes.size() <= 20u);
    for (size_t i = 1; i < bytes.size(); ++i) {
        CHECK(bytes[i] - bytes[i - 1] >= 10'000u);
    }
}

TEST(ota_job_status_every_second_while_stalled)
{
    OtaRig r;
    r.boot();
    r.offer(make_image({}));
    until_accepted(r);
    const size_t before = r.statuses().size();
    // fr_worker blocks in a read (no worker steps run): the hub still hears progress every second.
    r.core.advance_ms(3500);
    const auto st = r.statuses();
    REQUIRE_EQ(st.size(), before + 3);
    CHECK_EQ(st.back().bytes, st[before].bytes);
    CHECK_EQ(st.back().state, static_cast<uint8_t>(ota::Phase::downloading));
    const auto sent = r.host.of(proto::kKindOtaStatus);
    CHECK(!sent.back().ack_req);
}

TEST(ota_job_rejects_from_the_image_before_any_flash_write)
{
    const struct {
        ImageSpec spec;
        ota::Reject want;
    } cases[] = {
        {{.chip_id = 5}, ota::Reject::chip},
        {{.min_rev = 3}, ota::Reject::chip},
        {{.profile = "c6-pad-mono"}, ota::Reject::identity},
        {{.part = "fr-8mb-v1"}, ota::Reject::identity},
        {{.version = "0.0.1"}, ota::Reject::downgrade},
        {{.magic = 0}, ota::Reject::bad_image},
        {{.fr_magic = 0x12345678}, ota::Reject::bad_image},
        {{.hash_appended = 0}, ota::Reject::bad_image},
    };
    for (const auto &c : cases) {
        OtaRig r;
        r.boot();
        auto reply = r.offer(make_image(c.spec));
        CHECK(!reply.has());
        r.settle();
        const auto rej = r.answers(kReject);
        REQUIRE_EQ(rej.size(), 1u);
        CHECK_EQ(rej[0].job, "ota-1");
        CHECK_EQ(rej[0].code, code(c.want));
        CHECK_EQ(r.host.count(kAccept), 0u);
        CHECK(r.flash.begins.empty());
        CHECK(r.flash.slot.empty());
        CHECK_EQ(r.store.saves, 0);
        CHECK(!r.fetch.open);
        CHECK(!r.ota.busy());
        CHECK(r.results().empty());
    }
}

TEST(ota_job_flags_lift_identity_and_downgrade)
{
    {
        OtaRig r;
        r.boot();
        r.offer(make_image({.profile = "c6-pad-mono"}), ota::kOfferForce);
        r.settle();
        CHECK_EQ(r.host.count(kAccept), 1u);
        CHECK_EQ(r.host.restarts, 1);
    }
    {
        OtaRig r;
        r.boot();
        r.offer(make_image({.version = "0.0.1"}), ota::kOfferAllowDowngrade);
        r.settle();
        CHECK_EQ(r.host.count(kAccept), 1u);
    }
}

TEST(ota_job_rejects_from_the_offer_at_once)
{
    const auto img = make_image({});
    {
        OtaRig r;  // larger than the update slot
        r.boot();
        auto reply = r.offer(img, 0, "ota-1", std::nullopt, 0x1E0001);
        REQUIRE(reply.has());
        CHECK_EQ(reply.kind(), kReject);
        CHECK_EQ(frt::reply_answer(reply).code, code(ota::Reject::size));
        CHECK(!r.ota.busy());
        CHECK_EQ(r.worker.posted, 0u);
    }
    {
        OtaRig r;  // the running image
        r.boot();
        auto reply = r.offer(img, 0, "ota-1", r.flash.info.fw_id);
        CHECK_EQ(frt::reply_answer(reply).code, code(ota::Reject::same_fw));
    }
    {
        OtaRig r;  // the image that rolled back last time
        r.flash.info.has_last_invalid = true;
        r.flash.info.last_invalid_fw_id = fw_of(img);
        r.boot();
        auto reply = r.offer(img);
        CHECK_EQ(frt::reply_answer(reply).code, code(ota::Reject::same_fw));
        // FORCE installs it all the same.
        auto forced = r.offer(img, ota::kOfferForce, "ota-2");
        CHECK(!forced.has());
        r.settle();
        CHECK_EQ(r.host.count(kAccept), 1u);
    }
    {
        OtaRig r;  // no TCP session to download over
        r.host.has_endpoint = false;
        r.boot();
        auto reply = r.offer(img);
        CHECK_EQ(frt::reply_answer(reply).code, code(ota::Reject::busy));
        CHECK(!r.ota.busy());
    }
    {
        OtaRig r;  // fr_worker's queue is full of other slow work
        r.boot();
        for (size_t i = 0; i < fr::worker::kQueueDepth; ++i) {
            r.worker.post([] {});
        }
        auto reply = r.offer(img);
        CHECK_EQ(frt::reply_answer(reply).code, code(ota::Reject::busy));
        CHECK(!r.ota.busy());
    }
    {
        OtaRig r;  // an fw_id that is not a SHA-256, an image too small for its descriptors
        r.boot();
        fr::net::OtaReply reply;
        const std::vector<uint8_t> short_fw(31, 0xAB);
        r.ota.on_frame(proto::kKindOtaOffer,
                       frt::body_of(proto::OtaOffer{.job_id = "ota-1", .fw_id = short_fw, .size = 100'000}), reply);
        CHECK_EQ(frt::reply_answer(reply).code, code(ota::Reject::bad_image));
        auto tiny = r.offer(img, 0, "ota-2", std::nullopt, 399);
        CHECK_EQ(frt::reply_answer(tiny).code, code(ota::Reject::bad_image));
    }
}

TEST(ota_job_malformed_offer_gets_no_answer)
{
    OtaRig r;
    r.boot();
    fr::net::OtaReply reply;
    r.ota.on_frame(proto::kKindOtaOffer, frt::body_of(proto::OtaOffer{.job_id = "", .size = 1000}), reply);
    CHECK(!reply.has());  // no job id to answer to
    const std::vector<uint8_t> junk{0x0a, 0xff};
    r.ota.on_frame(proto::kKindOtaOffer, junk, reply);
    CHECK(!reply.has());
    CHECK(!r.ota.busy());
    // Node -> hub kinds and CHUNK are not for the node.
    r.ota.on_frame(proto::kKindOtaResult, junk, reply);
    r.ota.on_frame(proto::kKindOtaChunk, junk, reply);
    CHECK(!reply.has());
}

TEST(ota_job_second_offer_while_running)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({});
    r.offer(img);
    // Another job: busy, at once.
    auto other = r.offer(make_image({.seed = 2}), 0, "ota-2");
    CHECK_EQ(frt::reply_answer(other).code, code(ota::Reject::busy));
    // This job again before the ACCEPT is out: no second answer, the ACCEPT follows.
    auto again = r.offer(img);
    CHECK(!again.has());
    until_accepted(r);
    // And after it: the same ACCEPT, synchronously (the hub lost the first one).
    auto third = r.offer(img);
    REQUIRE(third.has());
    CHECK_EQ(third.kind(), kAccept);
    CHECK_EQ(frt::reply_answer(third).job, "ota-1");
    r.settle();
    CHECK_EQ(r.fetch.starts.size(), 1u);  // one download all along
    CHECK_EQ(r.host.restarts, 1);
}

TEST(ota_job_range_reissued_after_a_broken_read)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({.size = 150'000});
    r.fetch.drops = {200, 5000, 70'001};  // in the head, mid-chunk, after a stored resume point
    r.offer(img);
    r.settle();
    REQUIRE_EQ(r.fetch.starts.size(), 4u);
    CHECK_EQ(r.fetch.starts[0].from, 0u);
    CHECK_EQ(r.fetch.starts[1].from, 200u);  // the buffered bytes are kept: Range from what arrived
    CHECK_EQ(r.fetch.starts[2].from, 5000u);
    CHECK_EQ(r.fetch.starts[3].from, 70'001u);
    for (const auto &s : r.fetch.starts) {
        CHECK_EQ(s.url, r.fetch.starts[0].url);
    }
    CHECK(r.flash.slot == img);
    CHECK_EQ(r.flash.begins.size(), 1u);  // the slot stays open across re-issues
    CHECK_EQ(r.host.restarts, 1);
    CHECK_EQ(r.host.count(kAccept), 1u);
}

TEST(ota_job_fails_after_five_reissues)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({.size = 150'000});
    r.fetch.drops = {10'000, 20'000, 30'000, 40'000, 50'000, 70'000};
    r.offer(img);
    r.settle();
    CHECK_EQ(r.fetch.starts.size(), 1u + ota::kRangeRetries);
    const auto res = r.results();
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].job, "ota-1");
    CHECK_EQ(res[0].outcome, static_cast<uint8_t>(ota::Outcome::failed));
    CHECK_EQ(res[0].reason, static_cast<uint8_t>(ota::FailReason::download));
    CHECK_BYTES(res[0].prefix, std::span<const uint8_t>(fw_of(img).data(), 8));
    CHECK(r.host.of(proto::kKindOtaResult)[0].ack_req);  // Q1: the hub ACKs it
    CHECK_EQ(r.flash.aborts, 1);
    CHECK_EQ(r.flash.set_boots, 0);
    CHECK_EQ(r.host.restarts, 0);
    CHECK(!r.ota.busy());
    // The resume point stays for the hub's retry.
    REQUIRE(r.store.rec.has_value());
    CHECK_EQ(r.store.rec->off, 65'536u);
    CHECK(r.store.rec->state == ota::RecState::download);
}

TEST(ota_job_connect_failures_count_as_reissues)
{
    {
        OtaRig r;
        r.boot();
        r.fetch.fail_starts = 2;
        r.offer(make_image({}));
        r.settle();
        CHECK_EQ(r.fetch.starts.size(), 3u);
        CHECK_EQ(r.host.restarts, 1);
    }
    {
        OtaRig r;  // never reachable: no ACCEPT ever, RESULT failed download
        r.boot();
        r.fetch.fail_starts = 100;
        r.offer(make_image({}));
        r.settle();
        CHECK_EQ(r.fetch.starts.size(), 1u + ota::kRangeRetries);
        CHECK_EQ(r.host.count(kAccept), 0u);
        CHECK_EQ(r.host.count(kReject), 0u);
        REQUIRE_EQ(r.results().size(), 1u);
        CHECK_EQ(r.results()[0].reason, static_cast<uint8_t>(ota::FailReason::download));
        CHECK(r.flash.begins.empty());
        CHECK(!r.ota.busy());
    }
}

TEST(ota_job_resume_point_every_64k_after_the_bytes_are_flashed)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({.size = 300'000});
    r.fetch.max_read = 1460;
    r.offer(img);
    for (int i = 0; i < 1000 && r.step(); ++i) {
        // The stored offset never runs ahead of the slot: a resume continues after bytes that are in flash.
        if (r.store.rec) {
            CHECK(r.store.rec->off <= r.flash.slot.size());
        }
    }
    REQUIRE(!r.store.offs.empty());
    const std::vector<uint32_t> want{65'536, 131'072, 196'608, 262'144};
    CHECK(r.store.offs == want);
    CHECK_EQ(r.store.rec->off, 0u);  // cleared after esp_ota_end, with `installed`
    for (uint32_t off : r.store.offs) {
        CHECK_EQ(off % ota::kChunk, 0u);
    }
    CHECK_EQ(r.host.restarts, 1);
}

TEST(ota_job_resumes_after_a_reboot)
{
    OtaRig r;
    const auto img = make_image({.size = 300'000});
    // An earlier boot got 128 KB in before the power went (the job of the hub's first attempt).
    r.store.rec = ota::Record{.fw_id = fw_of(img), .size = 300'000, .off = 131'072, .slot = 0x1F0000, .hub_seen = true};
    std::snprintf(r.store.rec->job_id, sizeof(r.store.rec->job_id), "%s", "ota-1");
    r.flash.slot.assign(img.begin(), img.begin() + 131'072);
    r.boot();
    CHECK(r.results().empty());  // an interrupted download is nothing to report
    r.offer(img, 0, "ota-1-retry");
    r.settle();
    const auto acc = r.answers(kAccept);
    REQUIRE_EQ(acc.size(), 1u);
    CHECK_EQ(acc[0].code, static_cast<uint8_t>(ota::Accept::resumed));
    CHECK_EQ(r.flash.reads, 1);  // the descriptors read back for CHECK
    REQUIRE_EQ(r.flash.begins.size(), 1u);
    CHECK_EQ(r.flash.begins[0].second, 131'072u);  // esp_ota_resume
    REQUIRE_EQ(r.fetch.starts.size(), 1u);
    CHECK_EQ(r.fetch.starts[0].from, 131'072u);  // Range: bytes=131072-
    CHECK(r.flash.slot == img);
    CHECK_EQ(r.host.restarts, 1);
    // The record now names this job, and STATUS counted from the resume point.
    CHECK_EQ(std::string_view(r.store.rec->job_id), "ota-1-retry");
    for (const auto &s : r.statuses()) {
        CHECK(s.bytes >= 131'072u);
    }
}

TEST(ota_job_resume_runs_check_on_the_read_back_descriptor)
{
    OtaRig r;
    const auto img = make_image({.size = 300'000});
    r.store.rec = ota::Record{.fw_id = fw_of(img), .size = 300'000, .off = 65'536, .slot = 0x1F0000, .hub_seen = true};
    // What is in the slot is not what the record says (another profile's image): CHECK catches it.
    const auto other = make_image({.size = 300'000, .profile = "c6-pad-mono"});
    r.flash.slot.assign(other.begin(), other.begin() + 65'536);
    r.boot();
    r.offer(img);
    r.settle();
    const auto rej = r.answers(kReject);
    REQUIRE_EQ(rej.size(), 1u);
    CHECK_EQ(rej[0].code, code(ota::Reject::identity));
    CHECK(r.fetch.starts.empty());
    CHECK(r.flash.begins.empty());
}

TEST(ota_job_resume_only_for_the_same_image_and_slot)
{
    const auto img = make_image({.size = 300'000});
    const auto other = make_image({.size = 300'000, .seed = 9});
    const ota::Record base{.fw_id = fw_of(img), .size = 300'000, .off = 131'072, .slot = 0x1F0000, .hub_seen = true};
    std::vector<ota::Record> variants;
    variants.push_back(base);
    variants.back().fw_id = fw_of(other);  // another image
    variants.push_back(base);
    variants.back().size = 300'004;  // another size
    variants.push_back(base);
    variants.back().slot = 0x10000;  // the other slot (the device booted the other way since)
    variants.push_back(base);
    variants.back().off = 131'000;  // not a sector boundary
    variants.push_back(base);
    variants.back().off = 0;  // nothing stored yet
    variants.push_back(base);
    variants.back().off = 300'000;  // all of it: finished and staged, never resumed
    variants.push_back(base);
    variants.back().state = ota::RecState::installed;
    for (const auto &v : variants) {
        OtaRig r;
        r.store.rec = v;
        r.flash.slot.assign(img.begin(), img.begin() + 131'072);
        r.boot();
        r.offer(img);
        r.settle();
        REQUIRE_EQ(r.fetch.starts.size(), 1u);
        CHECK_EQ(r.fetch.starts[0].from, 0u);
        REQUIRE_EQ(r.answers(kAccept).size(), 1u);
        CHECK_EQ(r.answers(kAccept)[0].code, static_cast<uint8_t>(ota::Accept::fresh));
        CHECK(r.flash.slot == img);
    }
}

TEST(ota_job_retry_after_a_failed_job_resumes_in_the_same_boot)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({.size = 200'000});
    r.fetch.drops = {140'000, 140'001, 140'002, 140'003, 140'004, 140'005};
    r.offer(img);
    r.settle();
    REQUIRE_EQ(r.results().size(), 1u);
    CHECK(!r.ota.busy());
    // The hub retries the job (a new OFFER): it continues from the stored 128 KB.
    r.fetch.starts.clear();
    r.offer(img, 0, "ota-1b");
    r.settle();
    REQUIRE_EQ(r.answers(kAccept).size(), 2u);
    CHECK_EQ(r.answers(kAccept)[1].code, static_cast<uint8_t>(ota::Accept::resumed));
    REQUIRE(!r.fetch.starts.empty());
    CHECK_EQ(r.fetch.starts[0].from, 131'072u);
    CHECK(r.flash.slot == img);
    CHECK_EQ(r.host.restarts, 1);
}

TEST(ota_job_verify_mismatch_fails_with_digest)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({});
    std::array<uint8_t, 32> pinned{};
    pinned.fill(0x5A);  // the OFFER pins another digest than the image carries
    r.offer(img, 0, "ota-1", pinned);
    r.settle();
    const auto res = r.results();
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].outcome, static_cast<uint8_t>(ota::Outcome::failed));
    CHECK_EQ(res[0].reason, static_cast<uint8_t>(ota::FailReason::digest));
    CHECK_BYTES(res[0].prefix, std::span<const uint8_t>(pinned.data(), 8));
    CHECK_EQ(r.flash.set_boots, 0);
    CHECK_EQ(r.host.restarts, 0);
    CHECK(!r.ota.busy());
    // Never resumed into: the next OFFER starts over.
    REQUIRE(r.store.rec.has_value());
    CHECK_EQ(r.store.rec->off, 0u);
}

TEST(ota_job_flash_errors)
{
    const auto img = make_image({.size = 150'000});
    const auto reason = [](OtaRig &r) {
        const auto res = r.results();
        return res.size() == 1 ? res[0].reason : uint8_t{0xFF};
    };
    {
        OtaRig r;  // esp_ota_end: the image does not verify
        r.boot();
        r.flash.finish_invalid = true;
        r.offer(img);
        r.settle();
        CHECK_EQ(reason(r), static_cast<uint8_t>(ota::FailReason::digest));
    }
    {
        OtaRig r;  // esp_ota_end: a flash error
        r.boot();
        r.flash.finish_fails = true;
        r.offer(img);
        r.settle();
        CHECK_EQ(reason(r), static_cast<uint8_t>(ota::FailReason::flash));
    }
    {
        OtaRig r;  // esp_ota_write
        r.boot();
        r.flash.fail_write_after = 50'000;
        r.offer(img);
        r.settle();
        CHECK_EQ(reason(r), static_cast<uint8_t>(ota::FailReason::flash));
        CHECK_EQ(r.flash.aborts, 1);
        CHECK(!r.fetch.open);
    }
    {
        OtaRig r;  // esp_ota_begin: no ACCEPT, the RESULT says why
        r.boot();
        r.flash.fail_begin = true;
        r.offer(img);
        r.settle();
        CHECK_EQ(r.host.count(kAccept), 0u);
        CHECK_EQ(reason(r), static_cast<uint8_t>(ota::FailReason::flash));
    }
    {
        OtaRig r;  // esp_ota_set_boot_partition: the record goes back to a plain download
        r.boot();
        r.flash.fail_set_boot = true;
        r.offer(img);
        r.settle();
        CHECK_EQ(reason(r), static_cast<uint8_t>(ota::FailReason::flash));
        CHECK_EQ(r.host.restarts, 0);
        REQUIRE(r.store.rec.has_value());
        CHECK(r.store.rec->state == ota::RecState::download);
        CHECK(!r.ota.busy());
    }
}

TEST(ota_job_defer_commit_stages_until_commit)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({});
    r.offer(img, ota::kOfferDeferCommit);
    r.settle();
    CHECK_EQ(r.flash.finishes, 1);
    CHECK_EQ(r.flash.set_boots, 0);
    CHECK_EQ(r.host.restarts, 0);
    CHECK(r.ota.busy());
    const auto st = r.statuses();
    REQUIRE(!st.empty());
    CHECK_EQ(st.back().state, static_cast<uint8_t>(ota::Phase::staged));
    CHECK_EQ(st.back().bytes, img.size());
    REQUIRE(r.store.rec.has_value());
    CHECK(r.store.rec->state == ota::RecState::download);  // not yet what the next boot runs
    CHECK_EQ(r.store.rec->off, 0u);
    // A staged job stays staged: no tick runs for it.
    r.core.advance_ms(10'000);
    CHECK_EQ(r.statuses().size(), st.size());
    // Another job's COMMIT changes nothing.
    r.commit("ota-9");
    r.settle();
    CHECK_EQ(r.flash.set_boots, 0);
    r.commit("ota-1");
    r.settle();
    CHECK_EQ(r.flash.set_boots, 1);
    CHECK_EQ(r.host.restarts, 1);
    CHECK_EQ(r.statuses().back().state, static_cast<uint8_t>(ota::Phase::rebooting));
    CHECK(r.store.rec->state == ota::RecState::installed);
    CHECK(r.results().empty());
}

TEST(ota_job_commit_outside_staged_is_ignored)
{
    OtaRig r;
    r.boot();
    r.commit("ota-1");  // no job
    r.offer(make_image({}));
    until_accepted(r);
    r.commit("ota-1");  // downloading: not staged (no DEFER_COMMIT)
    r.settle();
    CHECK_EQ(r.flash.set_boots, 1);  // its own install only
    CHECK_EQ(r.host.restarts, 1);
}

TEST(ota_job_abort_while_downloading)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({.size = 150'000});
    r.offer(img);
    until_accepted(r);
    r.step();
    r.abort("ota-other");  // not this job
    CHECK(r.ota.busy());
    r.abort("ota-1");
    CHECK(r.ota.busy());  // until fr_worker has let go of the slot
    r.settle();
    CHECK(!r.ota.busy());
    CHECK_EQ(r.flash.aborts, 1);
    CHECK(!r.fetch.open);
    CHECK(r.results().empty());  // the hub asked: no RESULT
    CHECK_EQ(r.flash.set_boots, 0);
    // The next job runs.
    r.offer(make_image({.seed = 3}), 0, "ota-2");
    r.settle();
    CHECK_EQ(r.host.restarts, 1);
}

TEST(ota_job_abort_while_staged)
{
    OtaRig r;
    r.boot();
    r.offer(make_image({}), ota::kOfferDeferCommit);
    r.settle();
    r.abort("ota-1");
    CHECK(!r.ota.busy());
    r.commit("ota-1");  // too late
    r.settle();
    CHECK_EQ(r.flash.set_boots, 0);
    CHECK_EQ(r.host.restarts, 0);
}

TEST(ota_job_reoffer_while_aborting_is_busy)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({.size = 150'000});
    r.offer(img);
    until_accepted(r);
    r.step();
    // The hub's stall ABORT, while fr_worker is still blocked in a read (it sees the cancel at its next
    // step); the hub's retry re-OFFERs the same job_id meanwhile. busy, not the aborted attempt's ACCEPT.
    r.abort("ota-1");
    auto again = r.offer(img);
    REQUIRE(again.has());
    CHECK_EQ(again.kind(), kReject);
    CHECK_EQ(frt::reply_answer(again).job, "ota-1");
    CHECK_EQ(frt::reply_answer(again).code, code(ota::Reject::busy));
    r.settle();
    CHECK(!r.ota.busy());
    CHECK_EQ(r.host.count(kAccept), 1u);  // the first attempt's own
    CHECK_EQ(r.host.count(kReject), 0u);
    CHECK(r.results().empty());
    CHECK_EQ(r.flash.set_boots, 0);
    // Once the abort has settled, the next attempt runs.
    CHECK(!r.offer(img).has());
    r.settle();
    CHECK_EQ(r.host.count(kAccept), 2u);
    CHECK_EQ(r.host.restarts, 1);
}

TEST(ota_job_aborted_attempt_gets_no_accept_reject_or_result)
{
    {
        // CHECK passed on fr_worker just before the ABORT reached the core task: no ACCEPT goes out, and a
        // re-OFFER gets busy instead of silence.
        OtaRig r;
        r.boot();
        const auto img = make_image({});
        r.offer(img);
        r.worker.run_one();  // prepare
        r.worker.run_one();  // connect
        r.worker.run_one();  // head: CHECK passed, the ACCEPT waits in the mailbox
        r.abort("ota-1");
        CHECK_EQ(r.host.count(kAccept), 0u);
        auto again = r.offer(img);
        REQUIRE(again.has());
        CHECK_EQ(frt::reply_answer(again).code, code(ota::Reject::busy));
        r.settle();
        CHECK(!r.ota.busy());
        CHECK(r.host.sent.empty());
    }
    {
        // CHECK refused the image just before the ABORT: no REJECT under the job_id the hub reuses.
        OtaRig r;
        r.boot();
        r.offer(make_image({.profile = "c3o-pad"}));
        r.worker.run_one();
        r.worker.run_one();
        r.worker.run_one();  // head: REJECT identity in the mailbox
        r.abort("ota-1");
        r.settle();
        CHECK(!r.ota.busy());
        CHECK(r.host.sent.empty());
    }
    {
        // The slot failed while the ABORT came in: no RESULT failed for the hub to pin on its next attempt.
        OtaRig r;
        r.boot();
        r.flash.fail_write_after = 2 * ota::kChunk;
        r.flash.during_write = [&r] {
            if (r.flash.writes.size() == 3) {
                r.abort("ota-1");
            }
        };
        r.offer(make_image({.size = 150'000}));
        r.settle();
        CHECK(!r.ota.busy());
        CHECK_EQ(r.host.count(kAccept), 1u);
        CHECK(r.results().empty());
        CHECK_EQ(r.flash.aborts, 1);
    }
}

TEST(ota_job_abort_while_the_image_verifies_is_honoured)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({.size = 150'000});
    // The ABORT reaches the core task while fr_worker is in esp_ota_end and the partition hash.
    r.flash.during_finish = [&r] { r.abort("ota-1"); };
    r.offer(img);
    r.settle();
    CHECK_EQ(r.flash.finishes, 1);
    CHECK_EQ(r.flash.set_boots, 0);
    CHECK_EQ(r.host.restarts, 0);
    CHECK(!r.ota.busy());
    CHECK(r.results().empty());
    for (const auto &st : r.statuses()) {
        CHECK_EQ(st.state, static_cast<uint8_t>(ota::Phase::downloading));
    }
    // Nothing installed; the resume point stays for the hub's next attempt.
    REQUIRE(r.store.rec.has_value());
    CHECK(r.store.rec->state == ota::RecState::download);
    CHECK_EQ(r.store.rec->off, 2 * ota::kResumeStride);
    r.flash.during_finish = nullptr;
    r.offer(img);
    r.settle();
    const auto acc = r.answers(kAccept);
    REQUIRE_EQ(acc.size(), 2u);
    CHECK_EQ(acc[1].code, static_cast<uint8_t>(ota::Accept::resumed));
    CHECK_EQ(r.fetch.starts.back().from, 2 * ota::kResumeStride);
    CHECK_EQ(r.host.restarts, 1);
    CHECK(r.flash.slot == img);
}

TEST(ota_job_abort_before_the_boot_partition_changes_is_honoured)
{
    OtaRig r;
    r.boot();
    // The ABORT arrives while the record is saved `installed`, just before set_boot: the last cancel check.
    r.store.after_save = [&r](const ota::Record &rec) {
        if (rec.state == ota::RecState::installed) {
            r.abort("ota-1");
        }
    };
    r.offer(make_image({}));
    r.settle();
    CHECK_EQ(r.flash.set_boots, 0);
    CHECK_EQ(r.host.restarts, 0);
    CHECK(!r.ota.busy());
    CHECK(r.results().empty());
    REQUIRE(r.store.rec.has_value());
    CHECK(r.store.rec->state == ota::RecState::download);  // a later boot reports nothing about it
}

TEST(ota_job_abort_while_the_boot_partition_is_set_still_reboots)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({});
    // Past the last cancel check: the image is the boot partition. The node says so and restarts into it.
    r.flash.during_set_boot = [&r] { r.abort("ota-1"); };
    r.offer(img);
    r.settle();
    CHECK_EQ(r.flash.set_boots, 1);
    CHECK_EQ(r.host.restarts, 1);
    const auto st = r.statuses();
    REQUIRE(!st.empty());
    CHECK_EQ(st.back().state, static_cast<uint8_t>(ota::Phase::rebooting));
    CHECK_EQ(st.back().bytes, img.size());
    CHECK(r.results().empty());
    CHECK(r.store.rec->state == ota::RecState::installed);
}

TEST(ota_job_abort_racing_a_staged_end_is_not_lost)
{
    {
        // DEFER_COMMIT: fr_worker stages the image before the core task reads the mailbox, and the ABORT
        // is handled first. The job ends; nothing stays staged to refuse later jobs as busy.
        OtaRig r;
        r.boot();
        r.offer(make_image({}), ota::kOfferDeferCommit);
        r.worker.run_all();
        REQUIRE_EQ(r.flash.finishes, 1);
        r.abort("ota-1");
        CHECK(!r.ota.busy());
        CHECK(r.host.sent.empty());
        CHECK(!r.offer(make_image({.seed = 4}), 0, "ota-2").has());
        r.settle();
        CHECK_EQ(r.host.restarts, 1);
    }
    {
        // The ABORT while the image verifies: fr_worker does not stage it at all.
        OtaRig r;
        r.boot();
        r.flash.during_finish = [&r] { r.abort("ota-1"); };
        r.offer(make_image({}), ota::kOfferDeferCommit);
        r.settle();
        CHECK(!r.ota.busy());
        for (const auto &st : r.statuses()) {
            CHECK_EQ(st.state, static_cast<uint8_t>(ota::Phase::downloading));
        }
        r.commit("ota-1");
        r.settle();
        CHECK_EQ(r.flash.set_boots, 0);
    }
}

TEST(ota_job_download_continues_inline_when_the_worker_queue_is_full)
{
    /** fr_worker whose queue is full of other slow work once `refuse` is set. */
    struct BusyWorker final : fr::Worker {
        bool post(fr::Callback<void(), 32> job) override { return !refuse && inner.post(std::move(job)); }
        frt::FakeWorker inner;
        bool refuse = false;
    };
    OtaRig r;
    BusyWorker w;
    r.deps.worker = &w;
    r.boot();
    const auto img = make_image({});
    r.offer(img);
    w.refuse = true;
    // The first step cannot post its successor: it carries on inline, to the end of the download.
    REQUIRE(w.inner.run_one());
    r.core.run_ready();
    CHECK_EQ(w.inner.pending(), 0u);
    CHECK(r.flash.slot == img);
    CHECK_EQ(r.host.count(kAccept), 1u);
    CHECK_EQ(r.host.restarts, 1);
}

TEST(ota_job_lost_pokes_are_caught_up_by_the_tick)
{
    OtaRig r;
    r.boot();
    const auto img = make_image({});
    r.offer(img);
    // The core task's queue is full while fr_worker runs the whole download: every poke is dropped.
    int fillers = 0;
    while (r.core.post([&fillers] { ++fillers; })) {
    }
    r.worker.run_all();
    r.core.run_ready();  // only the fillers
    CHECK(fillers > 0);
    CHECK_EQ(r.host.count(kAccept), 0u);
    CHECK_EQ(r.host.restarts, 0);
    r.core.advance_ms(ota::kStatusMs);
    CHECK_EQ(r.host.count(kAccept), 1u);
    CHECK_EQ(r.host.restarts, 1);
    CHECK(r.flash.slot == img);
}

TEST(ota_job_accept_waits_for_a_session)
{
    OtaRig r;
    r.boot();
    r.host.session = false;  // the TCP session dropped right after the OFFER
    r.offer(make_image({}), ota::kOfferDeferCommit);
    r.settle();
    CHECK_EQ(r.host.count(kAccept), 0u);
    CHECK(r.host.refused > 0);
    // Back: the ACCEPT goes before anything else.
    r.host.session = true;
    r.core.advance_ms(ota::kStatusMs);
    REQUIRE(!r.host.sent.empty());
    CHECK_EQ(r.host.sent.front().kind, kAccept);
}

TEST(ota_job_unbound_ota_ignores_everything)
{
    fr::ota::Ota o;
    fr::net::OtaReply reply;
    o.on_boot();
    o.on_frame(proto::kKindOtaOffer,
               frt::body_of(proto::OtaOffer{.job_id = "ota-1", .fw_id = std::vector<uint8_t>(32, 1), .size = 1000}), reply);
    o.health_set(ota::kHealthCore);
    CHECK(!reply.has());
    CHECK(!o.busy());
    CHECK_EQ(o.health(), 0u);
    // bind() wants every dependency.
    frt::FakeCore core;
    ota::Deps d;
    d.core = &core;
    CHECK(!o.bind(d));
}
