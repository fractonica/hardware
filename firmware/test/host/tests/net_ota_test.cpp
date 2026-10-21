// fr_net OTA-class frames (design c4 §3, spec 05 §5.7-5.8): hub OTA frames on port 240 reach
// Host::ota_frame; an OFFER's ACCEPT/REJECT is its acknowledgement and is cached for a DUP; frames that
// are not unicast on port 240 are dropped; the node's OTA frames (OtaReply, send_ota) take TCP or serial,
// never UDP, even with udp_ok; send_ota with ack_req is a Q1 frame the hub ACKs.
#include "tests/net_fakes.hpp"

namespace {

using frt::Frame;
using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

std::vector<uint8_t> offer_body()
{
    std::vector<uint8_t> fw(32, 0xAB);
    return frt::HubSim::body_of(proto::OtaOffer{.job_id = "ota-0042", .fw_id = fw, .size = 1048576, .version = "0.3.1"});
}

std::vector<uint8_t> reject_body(uint8_t code)
{
    return frt::HubSim::body_of(proto::OtaReject{.job_id = "ota-0042", .code = code});
}

/** Answers every OFFER with REJECT `code` at once. */
frt::FakeHost::OnOta reject_offers(uint8_t code)
{
    return [code](const frt::FakeHost::OtaCall &c, fr::net::OtaReply &reply) {
        if (c.header.kind == proto::kKindOtaOffer) {
            const auto body = reject_body(code);
            reply.set(proto::kKindOtaReject, body);
        }
    };
}

std::vector<Frame> ota(const frt::FakeLink &l)
{
    return l.frames_of(wire::kClsOta);
}

}  // namespace

TEST(net_ota_offer_reaches_the_host_with_its_header)
{
    NetRig r;
    r.session(LinkKind::tcp);
    uint32_t seq = 0;
    r.deliver(LinkKind::tcp, r.hub.ota(proto::kKindOtaOffer, offer_body(), wire::kFlagAckReq, proto::kPortOta, &seq));
    REQUIRE_EQ(r.host.ota_calls.size(), 1u);
    const auto &c = r.host.ota_calls[0];
    CHECK(c.from == LinkKind::tcp);
    CHECK_EQ(c.header.kind, proto::kKindOtaOffer);
    CHECK_EQ(c.header.seq, seq);
    CHECK_EQ(c.header.port, proto::kPortOta);
    CHECK((c.header.flags & wire::kFlagAckReq) != 0);
    CHECK_BYTES(c.body, offer_body());
    // Not a CMD: nothing went through dispatch, and no RESULT answers it.
    CHECK(r.host.calls.empty());
    CHECK(r.tcp.frames_of(wire::kClsResult).empty());
    // COMMIT and ABORT arrive the same way.
    const auto commit = frt::HubSim::body_of(proto::OtaCommit{.job_id = "ota-0042"});
    r.deliver(LinkKind::tcp, r.hub.ota(proto::kKindOtaCommit, commit));
    REQUIRE_EQ(r.host.ota_calls.size(), 2u);
    CHECK_EQ(r.host.ota_calls[1].header.kind, proto::kKindOtaCommit);
}

TEST(net_ota_reply_is_an_ota_frame_on_port_240)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.host.on_ota = reject_offers(3);
    r.deliver(LinkKind::tcp, r.hub.ota(proto::kKindOtaOffer, offer_body(), wire::kFlagAckReq));
    auto out = ota(r.tcp);
    REQUIRE_EQ(out.size(), 1u);
    // OTA/REJECT from port 240 to the hub, no ACK_REQ (it is the OFFER's acknowledgement, 05 §5.8), and no
    // RESULT prefix: seq 4 (HELLO 1, boot 2, HEARTBEAT 3), net 0x00AB, src 5, epoch 9.
    std::vector<uint8_t> want = frt::from_hex("a1 00 09 03 04000000 ab00 0500 0000 0900 22 f0");
    const auto body = reject_body(3);
    want.insert(want.end(), body.begin(), body.end());
    CHECK_BYTES(out[0].bytes, want);
}

TEST(net_ota_dup_offer_gets_the_cached_answer_and_is_not_handed_on_twice)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.host.on_ota = reject_offers(1);
    const auto offer = r.hub.ota(proto::kKindOtaOffer, offer_body(), wire::kFlagAckReq);
    r.clear_sent();
    r.deliver(LinkKind::tcp, offer);
    r.deliver(LinkKind::tcp, offer);
    CHECK_EQ(r.host.ota_calls.size(), 1u);
    auto out = ota(r.tcp);
    REQUIRE_EQ(out.size(), 2u);
    CHECK_BYTES(out[1].bytes, out[0].bytes);
    CHECK_EQ(r.net.state().cached_replies, 1u);
}

TEST(net_ota_deferred_answer_and_a_dup_before_it)
{
    // ACCEPT comes after the image's first bytes are read: nothing answers the OFFER at once, and a DUP of it
    // in the meantime is dropped rather than handed on again (05 §5.8: never run twice).
    NetRig r;
    r.session(LinkKind::tcp);
    const auto offer = r.hub.ota(proto::kKindOtaOffer, offer_body(), wire::kFlagAckReq);
    r.clear_sent();
    r.deliver(LinkKind::tcp, offer);
    r.deliver(LinkKind::tcp, offer);
    CHECK_EQ(r.host.ota_calls.size(), 1u);
    CHECK(ota(r.tcp).empty());
    const auto accept = frt::HubSim::body_of(proto::OtaAccept{.job_id = "ota-0042", .code = 0});
    CHECK(r.net.send_ota(proto::kKindOtaAccept, accept).has_value());
    auto out = ota(r.tcp);
    REQUIRE_EQ(out.size(), 1u);
    CHECK_EQ(out[0].kind, proto::kKindOtaAccept);
    CHECK_EQ(out[0].port, proto::kPortOta);
    CHECK_EQ(out[0].dst, proto::kAddrHub);
    CHECK_EQ(out[0].flags, 0);
    CHECK_BYTES(out[0].body, accept);
}

TEST(net_ota_frames_off_port_240_or_not_unicast_are_dropped)
{
    NetRig r;
    r.session(LinkKind::tcp);
    const uint32_t drops = r.net.state().link(LinkKind::tcp).rx_drop;
    r.deliver(LinkKind::tcp, r.hub.ota(proto::kKindOtaOffer, offer_body(), wire::kFlagAckReq, 2));
    // A broadcast OFFER (BCAST space).
    r.deliver(LinkKind::tcp, r.hub.frame(0, wire::kClsOta, proto::kKindOtaOffer, ++r.hub.bcast, proto::kAddrBroadcast,
                                         proto::kPortOta, {}, offer_body()));
    CHECK(r.host.ota_calls.empty());
    CHECK_EQ(r.net.state().link(LinkKind::tcp).rx_drop, drops + 2);
}

TEST(net_ota_frames_never_ride_udp)
{
    NetRig r;
    r.udp_ok_session();
    REQUIRE(r.net.state().link(LinkKind::udp).udp_ok);
    r.clear_sent();
    r.host.on_ota = reject_offers(5);
    r.deliver(LinkKind::tcp, r.hub.ota(proto::kKindOtaOffer, offer_body(), wire::kFlagAckReq));
    const auto status = frt::HubSim::body_of(proto::OtaStatus{.job_id = "ota-0042", .state = 1, .bytes = 4096});
    CHECK(r.net.send_ota(proto::kKindOtaStatus, status).has_value());
    CHECK(r.net.send_ota(proto::kKindOtaResult, frt::HubSim::body_of(proto::OtaResult{.job_id = "ota-0042"}), true)
              .has_value());
    CHECK(ota(r.udp).empty());
    auto out = ota(r.tcp);
    REQUIRE_EQ(out.size(), 3u);
    CHECK_EQ(out[0].kind, proto::kKindOtaReject);
    CHECK_EQ(out[1].kind, proto::kKindOtaStatus);
    CHECK_EQ(out[2].kind, proto::kKindOtaResult);
    // A RESULT on the CMD path would have taken UDP here (udp_ok): only OTA frames are kept off it.
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 3));
    CHECK_EQ(r.udp.frames_of(wire::kClsResult).size(), 1u);
}

TEST(net_ota_from_udp_never_reaches_the_host)
{
    NetRig r;
    r.udp_ok_session();
    r.deliver(LinkKind::udp, r.hub.ota(proto::kKindOtaOffer, offer_body(), wire::kFlagAckReq));
    CHECK(r.host.ota_calls.empty());
}

TEST(net_send_ota_takes_serial_without_tcp_and_fails_without_a_session)
{
    NetRig r;
    const auto status = frt::HubSim::body_of(proto::OtaStatus{.job_id = "ota-0042", .state = 1, .bytes = 0});
    auto st = r.net.send_ota(proto::kKindOtaStatus, status);
    REQUIRE(!st.has_value());
    CHECK(st.error() == fr::Err::busy);
    r.session(LinkKind::serial);
    r.clear_sent();
    CHECK(r.net.send_ota(proto::kKindOtaStatus, status).has_value());
    CHECK_EQ(ota(r.serial).size(), 1u);
    // An OFFER over serial is answered over serial too (the only session).
    r.host.on_ota = reject_offers(1);
    r.deliver(LinkKind::serial, r.hub.ota(proto::kKindOtaOffer, offer_body(), wire::kFlagAckReq));
    CHECK_EQ(ota(r.serial).size(), 2u);
    // Over the realtime MTU: refused, nothing sent.
    std::vector<uint8_t> big(fr::proto::kMtuRealtime, 0);
    st = r.net.send_ota(proto::kKindOtaStatus, big);
    REQUIRE(!st.has_value());
    CHECK(st.error() == fr::Err::invalid_args);
    CHECK_EQ(ota(r.serial).size(), 2u);
}

TEST(net_send_ota_ack_req_is_q1)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    const auto result = frt::HubSim::body_of(proto::OtaResult{.job_id = "ota-0042", .outcome = 2, .reason = 1});
    REQUIRE(r.net.send_ota(proto::kKindOtaResult, result, true).has_value());
    auto out = ota(r.tcp);
    REQUIRE_EQ(out.size(), 1u);
    CHECK((out[0].flags & wire::kFlagAckReq) != 0);
    // The hub's ACK settles it (hub keepalives hold the session while the clock runs).
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, out[0].seq));
    r.core.advance_ms(2100);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    // Without one it fails after FR_TCP_DELIVERY_MS; TCP is never re-sent (05 §5.8): the job reports again.
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    REQUIRE(r.net.send_ota(proto::kKindOtaResult, result, true).has_value());
    r.core.advance_ms(1999);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    r.core.advance_ms(1);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
    CHECK_EQ(ota(r.tcp).size(), 2u);
    // Without ack_req nothing is tracked.
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    REQUIRE(r.net.send_ota(proto::kKindOtaStatus, result).has_value());
    r.core.advance_ms(2100);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
    CHECK(r.net.state().hub_link());
}

TEST(net_ota_bye_asked_for_inside_ota_frame_follows_the_reply)
{
    // A COMMIT that installs at once: the host answers and asks for BYE ota; the BYE goes after the answer.
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.host.on_ota = [&r](const frt::FakeHost::OtaCall &, fr::net::OtaReply &reply) {
        const auto body = frt::HubSim::body_of(proto::OtaStatus{.job_id = "ota-0042", .state = 4, .bytes = 0});
        reply.set(proto::kKindOtaStatus, body);
        r.net.bye(fr::net::kByeOta);
    };
    r.deliver(LinkKind::tcp, r.hub.ota(proto::kKindOtaCommit, frt::HubSim::body_of(proto::OtaCommit{.job_id = "ota-0042"})));
    auto all = r.tcp.frames();
    REQUIRE_EQ(all.size(), 2u);
    CHECK(all[0].is(wire::kClsOta, proto::kKindOtaStatus));
    CHECK(all[1].is(wire::kClsPresence, proto::kKindPresenceBye));
    CHECK_EQ(frt::field_u(all[1].body, 1), fr::net::kByeOta);
    CHECK(!r.net.state().hub_link());
}
