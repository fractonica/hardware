// The boot side of an OTA (design c4 §3, spec 06 §6.6): the health gate of a PENDING_VERIFY image (every
// required bit, HUB_ACK only with hub_seen, a fault build never passes, the deadline rolls back), RESULT
// success once valid and after a WELCOME, and the rolled_back report with its reason, sent once.
#include "tests/ota_fakes.hpp"

namespace {

using frt::make_image;
using frt::fw_of;
using frt::OtaRig;
namespace ota = fr::ota;
namespace proto = fr::proto;

constexpr uint32_t kAll = ota::kHealthCore | ota::kHealthCaps | ota::kHealthNet | ota::kHealthHubAck;
constexpr uint32_t kLocal = ota::kHealthCore | ota::kHealthCaps | ota::kHealthNet;

std::array<uint8_t, 32> digest(uint8_t v)
{
    std::array<uint8_t, 32> d{};
    for (size_t i = 0; i < d.size(); ++i) {
        d[i] = static_cast<uint8_t>(v + i);
    }
    return d;
}

ota::Record record(const char *job, const std::array<uint8_t, 32> &fw, ota::RecState state, bool hub_seen = true)
{
    ota::Record r;
    std::snprintf(r.job_id, sizeof(r.job_id), "%s", job);
    r.fw_id = fw;
    r.size = 900'000;
    r.slot = 0x10000;
    r.hub_seen = hub_seen;
    r.state = state;
    return r;
}

/** The first boot of the image job `ota-7` installed: PENDING_VERIFY, the record says installed. */
void new_image(OtaRig &r, bool hub_seen = true)
{
    r.flash.info.fw_id = digest(0x70);
    r.flash.info.pending_verify = true;
    r.store.rec = record("ota-7", digest(0x70), ota::RecState::installed, hub_seen);
}

/** The old image after `ota-8`'s image failed: the record names it, otadata says it is the last invalid. */
void rolled_back(OtaRig &r, ota::RecState state, bool crashed)
{
    r.flash.info.has_last_invalid = true;
    r.flash.info.last_invalid_fw_id = digest(0x80);
    r.flash.info.crashed = crashed;
    r.store.rec = record("ota-8", digest(0x80), state);
}

}  // namespace

TEST(ota_boot_nothing_to_do)
{
    OtaRig r;
    r.boot();
    CHECK(!r.ota.pending_verify());
    CHECK_EQ(r.ota.required(), 0u);
    CHECK_EQ(r.core.timers_running(), 0u);  // no deadline, no tick
    r.ota.health_set(kAll);
    r.settle();
    CHECK_EQ(r.flash.mark_valids, 0);
    CHECK(r.host.sent.empty());
    CHECK_EQ(r.core.timers_used(), 1u);  // Ota's one timer
}

TEST(ota_boot_health_gate_all_bits_then_success)
{
    OtaRig r;
    new_image(r);
    r.boot();
    CHECK(r.ota.pending_verify());
    CHECK_EQ(r.ota.required(), kAll);  // hub_seen: the hub was reachable before the update
    r.ota.health_set(ota::kHealthCore | ota::kHealthCaps);
    r.settle();
    r.ota.health_set(ota::kHealthNet);
    r.settle();
    CHECK_EQ(r.flash.mark_valids, 0);
    CHECK(r.host.sent.empty());
    // The WELCOME: valid, then RESULT success for the job that installed it.
    r.ota.health_set(ota::kHealthHubAck);
    r.settle();
    CHECK_EQ(r.flash.mark_valids, 1);
    CHECK(!r.ota.pending_verify());
    CHECK_EQ(r.ota.required(), 0u);
    const auto res = r.results();
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].job, "ota-7");
    CHECK_EQ(res[0].outcome, static_cast<uint8_t>(ota::Outcome::success));
    CHECK_BYTES(res[0].prefix, std::span<const uint8_t>(digest(0x70).data(), 8));
    CHECK_EQ(res[0].reason, 0);
    CHECK(r.host.of(proto::kKindOtaResult)[0].ack_req);
    // Reported once: the record is gone, later WELCOMEs and the old deadline do nothing.
    CHECK(!r.store.rec.has_value());
    r.ota.health_set(ota::kHealthHubAck);
    r.core.advance_ms(ota::kHealthDeadlineMs + 1000);
    r.settle();
    CHECK_EQ(r.results().size(), 1u);
    CHECK_EQ(r.flash.rollbacks, 0);
    CHECK_EQ(r.flash.mark_valids, 1);
}

TEST(ota_boot_hub_ack_only_with_hub_seen)
{
    OtaRig r;
    new_image(r, false);
    r.boot();
    CHECK_EQ(r.ota.required(), kLocal);
    r.ota.health_set(kLocal);
    r.settle();
    CHECK_EQ(r.flash.mark_valids, 1);  // no hub needed to stay
    CHECK(!r.ota.pending_verify());
    // The RESULT still waits for a WELCOME (design c4 §3).
    CHECK(r.results().empty());
    r.core.advance_ms(5000);
    CHECK(r.results().empty());
    r.ota.health_set(ota::kHealthHubAck);
    r.settle();
    REQUIRE_EQ(r.results().size(), 1u);
    CHECK_EQ(r.results()[0].outcome, static_cast<uint8_t>(ota::Outcome::success));
}

TEST(ota_boot_pending_without_a_record)
{
    // A PENDING_VERIFY image nobody recorded (nvs erased): the gate runs, nothing is reported.
    OtaRig r;
    r.flash.info.pending_verify = true;
    r.boot();
    CHECK_EQ(r.ota.required(), kLocal);
    r.ota.health_set(kAll);
    r.settle();
    CHECK_EQ(r.flash.mark_valids, 1);
    CHECK(r.results().empty());
}

TEST(ota_boot_deadline_rolls_back)
{
    OtaRig r;
    new_image(r);
    r.boot();
    r.ota.health_set(kLocal);  // the hub never answers
    r.settle();
    r.core.advance_ms(ota::kHealthDeadlineMs - 1);
    r.settle();
    CHECK_EQ(r.flash.rollbacks, 0);
    r.core.advance_ms(1);
    r.settle();
    CHECK_EQ(r.flash.rollbacks, 1);
    CHECK_EQ(r.flash.mark_valids, 0);
    // The record says the image gave up by itself, for the old image's report.
    REQUIRE(r.store.rec.has_value());
    CHECK(r.store.rec->state == ota::RecState::health_timeout);
    // Late bits change nothing; OFFERs stay refused until the reboot.
    r.ota.health_set(ota::kHealthHubAck);
    r.settle();
    CHECK_EQ(r.flash.mark_valids, 0);
    auto reply = r.offer(make_image({}));
    CHECK_EQ(frt::reply_answer(reply).code, static_cast<uint8_t>(ota::Reject::busy));
}

TEST(ota_boot_fault_build_never_passes)
{
    OtaRig r;
    new_image(r);
    r.deps.fault_health = true;  // CONFIG_FR_TEST_FAULT_HEALTH
    r.boot();
    r.ota.health_set(kAll);
    r.settle();
    CHECK_EQ(r.ota.health(), kAll & ~ota::kHealthCaps);
    CHECK_EQ(r.flash.mark_valids, 0);
    CHECK(r.ota.pending_verify());
    r.core.advance_ms(ota::kHealthDeadlineMs);
    r.settle();
    CHECK_EQ(r.flash.rollbacks, 1);
    CHECK(r.store.rec->state == ota::RecState::health_timeout);
    CHECK(r.results().empty());  // the old image reports, after the rollback
}

TEST(ota_boot_deadline_is_configurable)
{
    OtaRig r;
    new_image(r);
    r.deps.health_deadline_ms = 2000;  // fr_net_node's interop runs
    r.boot();
    r.core.advance_ms(1999);
    CHECK_EQ(r.flash.rollbacks, 0);
    r.core.advance_ms(1);
    r.settle();
    CHECK_EQ(r.flash.rollbacks, 1);
}

TEST(ota_boot_offer_refused_while_pending)
{
    OtaRig r;
    new_image(r);
    r.boot();
    auto reply = r.offer(make_image({}));
    REQUIRE(reply.has());
    CHECK_EQ(frt::reply_answer(reply).code, static_cast<uint8_t>(ota::Reject::busy));
    // Also while the mark-valid is on its way.
    r.ota.health_set(kAll);
    auto again = r.offer(make_image({}), 0, "ota-2");
    CHECK_EQ(frt::reply_answer(again).code, static_cast<uint8_t>(ota::Reject::busy));
    r.settle();
    CHECK(!r.ota.pending_verify());
    auto later = r.offer(make_image({}), 0, "ota-3");
    CHECK(!later.has());  // valid now: CHECK runs
}

TEST(ota_boot_mark_valid_in_flight_at_the_deadline)
{
    {
        OtaRig r;  // it succeeds: valid wins
        new_image(r);
        r.boot();
        r.core.advance_ms(ota::kHealthDeadlineMs - 10);
        r.ota.health_set(kAll);  // posted, fr_worker has not run it yet
        r.core.advance_ms(20);
        CHECK_EQ(r.flash.rollbacks, 0);
        r.settle();
        CHECK_EQ(r.flash.mark_valids, 1);
        CHECK_EQ(r.flash.rollbacks, 0);
        CHECK(!r.ota.pending_verify());
        CHECK_EQ(r.results().size(), 1u);
    }
    {
        OtaRig r;  // it fails: the rollback follows
        new_image(r);
        r.flash.fail_mark_valid = true;
        r.boot();
        r.core.advance_ms(ota::kHealthDeadlineMs - 10);
        r.ota.health_set(kAll);
        r.core.advance_ms(20);
        r.settle();
        CHECK_EQ(r.flash.mark_valids, 1);
        CHECK_EQ(r.flash.rollbacks, 1);
        CHECK(r.results().empty());
    }
}

TEST(ota_boot_failed_mark_valid_is_not_retried)
{
    OtaRig r;
    new_image(r);
    r.flash.fail_mark_valid = true;
    r.boot();
    r.ota.health_set(kAll);
    r.settle();
    r.ota.health_set(kAll);
    r.core.advance_ms(30'000);
    r.settle();
    CHECK_EQ(r.flash.mark_valids, 1);
    CHECK(r.ota.pending_verify());
    r.core.advance_ms(30'000);
    r.settle();
    CHECK_EQ(r.flash.rollbacks, 1);
}

TEST(ota_boot_rolled_back_report_with_reason_once)
{
    const struct {
        ota::RecState state;
        bool crashed;
        ota::RollbackReason want;
    } cases[] = {
        {ota::RecState::health_timeout, false, ota::RollbackReason::health_timeout},
        {ota::RecState::health_timeout, true, ota::RollbackReason::health_timeout},  // it gave up first
        {ota::RecState::installed, true, ota::RollbackReason::crash},    // panic or watchdog before valid
        {ota::RecState::installed, false, ota::RollbackReason::unknown},  // a power cut, a reset
    };
    for (const auto &c : cases) {
        OtaRig r;
        rolled_back(r, c.state, c.crashed);
        r.boot();
        CHECK(!r.ota.pending_verify());
        r.ota.health_set(kLocal);
        r.settle();
        CHECK(r.results().empty());  // design c4 §3: after the first WELCOME
        r.ota.health_set(ota::kHealthHubAck);
        r.settle();
        const auto res = r.results();
        REQUIRE_EQ(res.size(), 1u);
        CHECK_EQ(res[0].job, "ota-8");
        CHECK_EQ(res[0].outcome, static_cast<uint8_t>(ota::Outcome::rolled_back));
        CHECK_BYTES(res[0].prefix, std::span<const uint8_t>(digest(0x80).data(), 8));  // the invalid image's
        CHECK_EQ(res[0].reason, static_cast<uint8_t>(c.want));
        CHECK(r.host.of(proto::kKindOtaResult)[0].ack_req);
        CHECK(!r.store.rec.has_value());
        // Once: a reconnect does not repeat it, and neither does the next boot.
        r.ota.health_set(ota::kHealthHubAck);
        r.core.advance_ms(5000);
        CHECK_EQ(r.results().size(), 1u);
        CHECK_EQ(r.flash.mark_valids, 0);
        CHECK_EQ(r.flash.rollbacks, 0);
    }
}

TEST(ota_boot_report_waits_for_a_session)
{
    OtaRig r;
    rolled_back(r, ota::RecState::installed, true);
    r.host.session = false;  // the WELCOME's session is gone before the RESULT could leave
    r.boot();
    r.ota.health_set(ota::kHealthHubAck);
    r.settle();
    CHECK(r.results().empty());
    CHECK(r.store.rec.has_value());  // kept until it is out
    r.core.advance_ms(3000);
    CHECK(r.host.refused >= 3);  // retried every second
    r.host.session = true;
    r.core.advance_ms(1000);
    r.settle();
    REQUIRE_EQ(r.results().size(), 1u);
    CHECK(!r.store.rec.has_value());
    const size_t ticks = r.core.timers_running();
    CHECK_EQ(ticks, 0u);  // nothing left to wait for
}

TEST(ota_boot_no_report_without_the_rollback)
{
    {
        OtaRig r;  // installed, but the image that is the last invalid one is another: a stale record
        rolled_back(r, ota::RecState::installed, false);
        r.flash.info.last_invalid_fw_id = digest(0x90);
        r.boot();
        r.ota.health_set(kAll);
        r.settle();
        CHECK(r.results().empty());
        CHECK(r.store.rec.has_value());
    }
    {
        OtaRig r;  // an interrupted download: kept for the resume
        rolled_back(r, ota::RecState::download, false);
        r.boot();
        r.ota.health_set(kAll);
        r.settle();
        CHECK(r.results().empty());
        CHECK(r.store.rec.has_value());
    }
}

TEST(ota_boot_success_report_of_an_earlier_boot)
{
    // Marked valid in a boot that reset before its RESULT went out: this boot reports it.
    OtaRig r;
    r.flash.info.fw_id = digest(0x70);
    r.store.rec = record("ota-7", digest(0x70), ota::RecState::installed);
    r.boot();
    CHECK(!r.ota.pending_verify());
    r.ota.health_set(ota::kHealthHubAck);
    r.settle();
    REQUIRE_EQ(r.results().size(), 1u);
    CHECK_EQ(r.results()[0].outcome, static_cast<uint8_t>(ota::Outcome::success));
    CHECK_EQ(r.flash.mark_valids, 0);
}

TEST(ota_boot_new_job_keeps_its_record_from_an_old_report)
{
    OtaRig r;
    rolled_back(r, ota::RecState::installed, false);
    r.host.session = false;
    r.boot();
    r.ota.health_set(ota::kHealthHubAck);  // the report cannot leave yet
    r.settle();
    // A new job starts meanwhile (an OFFER always comes over a session) and rewrites nvs:fr_ota.
    r.host.session = true;
    const auto img = make_image({});
    r.offer(img, ota::kOfferDeferCommit, "ota-9");
    r.settle();
    REQUIRE_EQ(r.results().size(), 1u);  // the old report went at the job's first poke
    CHECK_EQ(r.results()[0].job, "ota-8");
    // ...and did not clear the new job's record.
    REQUIRE(r.store.rec.has_value());
    CHECK_EQ(std::string_view(r.store.rec->job_id), "ota-9");
    CHECK_EQ(r.store.clears, 0);
    CHECK(r.store.rec->fw_id == fw_of(img));
}
