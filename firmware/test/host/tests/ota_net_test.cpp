// Ota behind the real fr_net core (design c4 §3), wired as fr_core wires it: Host::ota_frame forwards to
// Ota::on_frame, Ota's frames leave through Net::send_ota, the restart is BYE ota. A REJECT decided from
// the OFFER is its cached acknowledgement (a DUP gets the same bytes), the ACCEPT that follows the CHECK and
// everything after it ride TCP (never UDP, even with udp_ok), and RESULTs are Q1 frames the hub ACKs.
#include "tests/net_fakes.hpp"
#include "tests/ota_fakes.hpp"

namespace {

using fr::net::LinkKind;
using frt::Frame;
namespace ota = fr::ota;
namespace proto = fr::proto;
namespace wire = fr::wire;

/** fr_core's OtaHost (core.cpp) over a Net: the endpoint is the TCP session's hub. */
class NetOtaHost final : public ota::Host
{
public:
    explicit NetOtaHost(fr::net::Net &net) : net_(net) {}

    fr::Status send(uint8_t kind, std::span<const uint8_t> body, bool ack_req) override
    {
        return net_.send_ota(kind, body, ack_req);
    }
    bool endpoint(ota::Endpoint &out) override
    {
        if (!net_.state().link(LinkKind::tcp).session) {
            return false;
        }
        std::snprintf(out.host, sizeof(out.host), "%s", "127.0.0.1");
        out.port = ota::kHttpPort;
        return true;
    }
    void restart() override
    {
        ++restarts;
        net_.bye(fr::net::kByeOta);
    }

    int restarts = 0;

private:
    fr::net::Net &net_;
};

struct Rig {
    Rig()
    {
        flash.info = frt::default_running();
        ota::Deps d;
        d.core = &n.core;
        d.worker = &worker;
        d.flash = &flash;
        d.fetch = &fetch;
        d.store = &store;
        d.host = &host;
        d.ident = frt::default_ident();
        n.host.on_ota = [this](const frt::FakeHost::OtaCall &c, fr::net::OtaReply &reply) {
            o.on_frame(c.header.kind, c.body, reply);
        };
        bound = o.bind(d);
    }

    void boot()
    {
        o.on_boot();
        n.core.run_ready();
    }

    std::vector<uint8_t> offer_env(const std::vector<uint8_t> &img, uint32_t size, const std::string &job = "ota-1")
    {
        fetch.image = img;
        const auto fw = frt::fw_of(img);
        return n.hub.ota(proto::kKindOtaOffer,
                         frt::body_of(proto::OtaOffer{.job_id = job, .fw_id = fw, .size = size, .version = "0.2.0"}),
                         wire::kFlagAckReq);
    }

    void settle()
    {
        for (int guard = 0; guard < 100000; ++guard) {
            n.core.run_ready();
            if (!worker.run_one()) {
                n.core.run_ready();
                return;
            }
        }
    }

    frt::NetRig n;
    frt::FakeWorker worker;
    frt::FakeFlash flash;
    frt::FakeFetch fetch;
    frt::FakeStore store;
    NetOtaHost host{n.net};
    ota::Ota o;
    bool bound = false;
};

std::vector<Frame> ota_frames(const frt::FakeLink &l)
{
    return l.frames_of(wire::kClsOta);
}

}  // namespace

TEST(ota_net_reject_is_the_offers_cached_answer)
{
    Rig r;
    REQUIRE(r.bound);
    r.boot();
    r.n.session(LinkKind::tcp);
    r.n.clear_sent();
    const auto img = frt::make_image({});
    const auto env = r.offer_env(img, 0x1E0001);  // larger than the slot
    r.n.deliver(LinkKind::tcp, env);
    auto out = ota_frames(r.n.tcp);
    REQUIRE_EQ(out.size(), 1u);
    CHECK(out[0].is(wire::kClsOta, proto::kKindOtaReject));
    CHECK_EQ(out[0].port, proto::kPortOta);
    CHECK_EQ(out[0].dst, proto::kAddrHub);
    CHECK_EQ(out[0].flags & wire::kFlagAckReq, 0);
    CHECK_EQ(frt::answer_of(proto::kKindOtaReject, out[0].body).code, static_cast<uint8_t>(ota::Reject::size));
    // The hub did not hear it and sends the same OFFER again: the same bytes, Ota not asked twice.
    r.n.deliver(LinkKind::tcp, env);
    out = ota_frames(r.n.tcp);
    REQUIRE_EQ(out.size(), 2u);
    CHECK(out[1].bytes == out[0].bytes);
    CHECK_EQ(r.n.host.ota_calls.size(), 1u);
}

TEST(ota_net_accept_status_and_bye_ota_over_tcp_never_udp)
{
    Rig r;
    r.boot();
    r.n.udp_ok_session();  // UDP works too: OTA frames still take TCP
    r.n.clear_sent();
    const auto img = frt::make_image({.size = 150'000});
    r.n.deliver(LinkKind::tcp, r.offer_env(img, static_cast<uint32_t>(img.size())));
    CHECK(ota_frames(r.n.tcp).empty());  // the ACCEPT waits for CHECK
    r.settle();
    const auto out = ota_frames(r.n.tcp);
    REQUIRE(out.size() >= 2u);
    CHECK(out[0].is(wire::kClsOta, proto::kKindOtaAccept));
    CHECK_EQ(out[0].port, proto::kPortOta);
    CHECK_EQ(out[0].flags & wire::kFlagAckReq, 0);
    CHECK(out.back().is(wire::kClsOta, proto::kKindOtaStatus));
    CHECK_EQ(frt::status_of(out.back().body).state, static_cast<uint8_t>(ota::Phase::rebooting));
    CHECK(r.n.udp.frames_of(wire::kClsOta).empty());
    CHECK(r.n.serial.frames_of(wire::kClsOta).empty());
    // BYE ota after the last STATUS, then the restart.
    CHECK_EQ(r.host.restarts, 1);
    const auto byes = r.n.tcp.frames(wire::kClsPresence, proto::kKindPresenceBye);
    REQUIRE_EQ(byes.size(), 1u);
    CHECK_EQ(frt::field_u(byes[0].body, 1), fr::net::kByeOta);
    CHECK(byes[0].seq > out.back().seq);
    CHECK(r.flash.slot == img);
}

TEST(ota_net_result_failed_is_q1_on_tcp)
{
    Rig r;
    r.boot();
    r.n.session(LinkKind::tcp);
    r.n.clear_sent();
    r.fetch.fail_starts = 100;  // the hub's HTTP port never answers
    const auto img = frt::make_image({});
    r.n.deliver(LinkKind::tcp, r.offer_env(img, static_cast<uint32_t>(img.size())));
    r.settle();
    const auto res = r.n.tcp.frames(wire::kClsOta, proto::kKindOtaResult);
    REQUIRE_EQ(res.size(), 1u);
    CHECK((res[0].flags & wire::kFlagAckReq) != 0);
    CHECK_EQ(frt::result_of(res[0].body).reason, static_cast<uint8_t>(ota::FailReason::download));
    // The hub's ACK settles it; nothing counts as failed delivery afterwards.
    r.n.deliver(LinkKind::tcp, r.n.hub.ack(r.n.host.id.epoch, res[0].seq));
    r.n.core.advance_ms(5000);
    CHECK_EQ(r.n.net.state().delivery_failed, 0u);
}

TEST(ota_net_offer_over_serial_without_tcp_is_busy)
{
    Rig r;
    r.boot();
    r.n.session(LinkKind::serial);  // USB only: Wi-Fi is down, nothing to download over
    r.n.clear_sent();
    const auto img = frt::make_image({});
    r.n.deliver(LinkKind::serial, r.offer_env(img, static_cast<uint32_t>(img.size())));
    const auto out = ota_frames(r.n.serial);
    REQUIRE_EQ(out.size(), 1u);
    CHECK(out[0].is(wire::kClsOta, proto::kKindOtaReject));
    CHECK_EQ(frt::answer_of(proto::kKindOtaReject, out[0].body).code, static_cast<uint8_t>(ota::Reject::busy));
}

TEST(ota_net_rolled_back_result_after_the_first_welcome)
{
    Rig r;
    r.flash.info.has_last_invalid = true;
    r.flash.info.last_invalid_fw_id.fill(0x80);
    r.flash.info.crashed = true;
    ota::Record rec;
    std::snprintf(rec.job_id, sizeof(rec.job_id), "%s", "ota-8");
    rec.fw_id.fill(0x80);
    rec.size = 900'000;
    rec.state = ota::RecState::installed;
    r.store.rec = rec;
    r.boot();
    r.n.up(LinkKind::tcp);
    CHECK(ota_frames(r.n.tcp).empty());
    r.n.deliver(LinkKind::tcp, r.n.hub.welcome());
    r.o.health_set(ota::kHealthHubAck);  // what fr_core does after a WELCOME
    r.settle();
    const auto res = r.n.tcp.frames(wire::kClsOta, proto::kKindOtaResult);
    REQUIRE_EQ(res.size(), 1u);
    CHECK((res[0].flags & wire::kFlagAckReq) != 0);
    const auto m = frt::result_of(res[0].body);
    CHECK_EQ(m.job, "ota-8");
    CHECK_EQ(m.outcome, static_cast<uint8_t>(ota::Outcome::rolled_back));
    CHECK_EQ(m.reason, static_cast<uint8_t>(ota::RollbackReason::crash));
    CHECK(!r.store.rec.has_value());
}

TEST(ota_net_heartbeat_ota_busy_follows_the_job)
{
    // fr_core's Vitals::ota_busy is Ota::busy(); HEARTBEAT state b2 carries it.
    Rig r;
    r.boot();
    r.n.session(LinkKind::tcp);
    r.n.host.vit.ota_busy = r.o.busy();
    CHECK(!r.n.host.vit.ota_busy);
    const auto img = frt::make_image({});
    r.n.deliver(LinkKind::tcp, r.offer_env(img, static_cast<uint32_t>(img.size())));
    r.n.host.vit.ota_busy = r.o.busy();
    r.n.clear_sent();
    r.n.core.advance_ms(1200);
    const auto hbs = r.n.tcp.frames(wire::kClsPresence, proto::kKindPresenceHeartbeat);
    REQUIRE(!hbs.empty());
    CHECK((frt::field_u(hbs.back().body, 2) & fr::net::kStateOtaBusy) != 0);
}
