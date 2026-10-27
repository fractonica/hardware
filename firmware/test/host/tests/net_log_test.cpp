// LOG frames over TCP (design m2-c2 D20, spec 05 §5.7, §5.12.1): Net's drain of a LogSource on FakeLink and
// FakeCore. Nothing before a settled TCP session (its TIME burst and get_state, or 3 s after WELCOME), then the
// backlog in order; 20 lines/s; held while the TX FIFO is not empty, while 1 KB of LOG is not cleared by a hub frame
// one RTT later, or while TCP is wifi-silent; lines older than 30 s dropped; never over serial or UDP; the level as
// the kind; whole lines as valid UTF-8, cut on a code-point boundary; the drop counters and their one marker line;
// URGENT events and HEARTBEATs never behind the backlog. Also fr_serial's IDF-free hook pieces (ANSI strip, the
// esp_log head, the joiner of vprintf fragments) that build the ring's lines on target.
//
// Two clocks (review fw-net-1): a line's push stamp ahead of or behind the drain's clock, the u32 ms wrap, the
// marker's `<ms>` on the clock the text prints, and the target sources that put the stamp on fr::Core's clock.
#include <climits>
#include <deque>
#include <fstream>
#include <functional>
#include <optional>
#include <sstream>
#include <string>

#include "../../../components/fr_serial/include/fr/serial.hpp"
#include "tests/net_fakes.hpp"

namespace {

using frt::Frame;
using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

/** The node's log ring as Net sees it: lines with their level, tag and push stamp, popped oldest first. */
class FakeLogs final : public fr::net::LogSource
{
public:
    struct Rec {
        uint8_t level;
        uint32_t pushed_ms;
        std::string tag;
        std::string text;
    };

    explicit FakeLogs(const fr::Core &core) : core_(core) {}

    /** A line pushed now (or at `at_ms`), as fr_serial's hook pushes one. */
    void push(std::string text, uint8_t level = proto::kKindLogI, std::string tag = "app",
              std::optional<uint32_t> at_ms = std::nullopt)
    {
        q.push_back({level, at_ms.value_or(static_cast<uint32_t>(core_.now() / 1000)), std::move(tag), std::move(text)});
    }

    bool pop(fr::net::LogLine &line, std::span<char> scratch) override
    {
        ++pops;
        if (on_pop) {
            on_pop();
        }
        if (q.empty()) {
            return false;
        }
        const Rec r = q.front();
        q.pop_front();
        const size_t tag = std::min(r.tag.size(), scratch.size());
        std::memcpy(scratch.data(), r.tag.data(), tag);
        const size_t text = std::min(r.text.size(), scratch.size() - tag);
        std::memcpy(scratch.data() + tag, r.text.data(), text);
        line = {.level = r.level,
                .pushed_ms = r.pushed_ms,
                .tag = {scratch.data(), tag},
                .text = {scratch.data() + tag, text}};
        return true;
    }

    /** The log clock the lines' text prints, `text_ahead_ms` ahead of the core clock (esp_log's is, on target). */
    uint32_t text_ms(uint32_t core_ms) const override { return core_ms + text_ahead_ms; }

    std::deque<Rec> q;
    int pops = 0;
    std::function<void()> on_pop;  // runs inside pop(), as fr_core's source reports its ring's drops
    uint32_t text_ahead_ms = 0;

private:
    const fr::Core &core_;
};

/** A NetRig whose Net drains FakeLogs. */
struct LogRig : NetRig {
    LogRig() { net.attach_logs(&logs); }
    FakeLogs logs{core};
};

/** One LOG frame as the hub would read it. */
struct Logged {
    fr::TimeUs at;
    uint8_t kind;
    uint8_t flags;
    uint8_t port;
    uint16_t dst;
    std::string tag;
    std::string text;
};

std::vector<Logged> logged(const frt::FakeLink &l)
{
    std::vector<Logged> out;
    for (const Frame &f : l.frames_of(wire::kClsLog)) {
        auto m = proto::decode_log_line(f.body);
        if (!m) {
            frt::fail(__FILE__, __LINE__, "a LOG frame whose LOG.LINE does not decode: " + frt::hex(f.body));
            continue;
        }
        out.push_back({f.at, f.kind, f.flags, f.port, f.dst, std::string(m->tag), std::string(m->text)});
    }
    return out;
}

std::vector<std::string> texts(const frt::FakeLink &l)
{
    std::vector<std::string> out;
    for (const Logged &x : logged(l)) {
        out.push_back(x.text);
    }
    return out;
}

/** The TCP session's handshake as the hub runs it: WELCOME, a TIME burst (each SYNC_REQ `rtt_ms` after the previous
 * answer), then get_state. */
void handshake(LogRig &r, uint32_t rtt_ms = 0, bool get_state = true)
{
    r.session(LinkKind::tcp);
    for (uint64_t i = 0; i < 4; ++i) {
        if (i > 0) {
            r.core.advance_ms(rtt_ms);
        }
        r.deliver(LinkKind::tcp, r.hub.sync_req(1000 + i));
    }
    if (get_state) {
        r.deliver(LinkKind::tcp, r.hub.cmd(proto::kPortNode, fr::cap::Node::kCmdGetState));
    }
}

/** Advances `ms` in `step_ms` steps, a hub frame over TCP after each (keepalives, echoes: what clears the window). */
void alive(LogRig &r, uint32_t ms, uint32_t step_ms = 50)
{
    while (ms > 0) {
        const uint32_t step = std::min(ms, step_ms);
        r.core.advance_ms(step);
        ms -= step;
        r.deliver(LinkKind::tcp, r.hub.heartbeat());
    }
}

std::string line_of(int n)
{
    return "I (" + std::to_string(1000 + n) + ") app: line " + std::to_string(n);
}

uint32_t core_ms(const LogRig &r)
{
    return static_cast<uint32_t>(r.core.now() / 1000);
}

/** The repository root, from this file's own path. */
std::string repo()
{
    std::string f = __FILE__;
    const size_t at = f.rfind("/firmware/test/host/tests/");
    return at == std::string::npos ? std::string(".") : f.substr(0, at);
}

std::string read(const std::string &rel)
{
    std::ifstream in(repo() + "/" + rel);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

/**
 * The code of the function whose definition starts with `head`, up to its closing brace in column 0, without its
 * `//` comments (which may name what the code must not call); "" if none.
 */
std::string code_of(const std::string &src, const std::string &head)
{
    const size_t at = src.find(head);
    const size_t end = at == std::string::npos ? at : src.find("\n}\n", at);
    if (end == std::string::npos) {
        return "";
    }
    std::string out;
    std::istringstream in(src.substr(at, end - at));
    for (std::string line; std::getline(in, line);) {
        out += line.substr(0, line.find("//")) + "\n";
    }
    return out;
}

}  // namespace

TEST(net_log_waits_for_a_settled_tcp_session)
{
    LogRig r;
    for (int i = 0; i < 5; ++i) {
        r.logs.push(line_of(i));
    }
    // No session, or a serial one only (a USB node on a charger port, Wi-Fi down): nothing, anywhere.
    r.session(LinkKind::serial);
    r.core.advance_ms(500);
    r.deliver(LinkKind::serial, r.hub.heartbeat());
    CHECK(r.serial.frames_of(wire::kClsLog).empty());
    CHECK_EQ(r.logs.pops, 0);
    // A TCP WELCOME, then its TIME burst: still nothing, the handshake's own frames go first.
    r.up(LinkKind::udp);
    handshake(r, 5, false);
    alive(r, 1000);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    CHECK_EQ(r.logs.pops, 0);
    // get_state answered: the backlog, in order, over TCP alone.
    r.deliver(LinkKind::tcp, r.hub.cmd(proto::kPortNode, fr::cap::Node::kCmdGetState));
    const auto got = texts(r.tcp);
    REQUIRE_EQ(got.size(), 5u);
    for (int i = 0; i < 5; ++i) {
        CHECK_EQ(got[static_cast<size_t>(i)], line_of(i));
    }
    CHECK(r.serial.frames_of(wire::kClsLog).empty());
    CHECK(r.udp.frames_of(wire::kClsLog).empty());
    CHECK_EQ(r.net.state().logs.sent, 5u);
}

TEST(net_log_settles_3s_after_welcome_without_get_state)
{
    LogRig r;
    r.logs.push(line_of(0));
    r.session(LinkKind::tcp);  // a hub that never sends get_state (or whose burst is lost)
    alive(r, 2950);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    alive(r, 50);
    CHECK_EQ(texts(r.tcp).size(), 1u);
    // A new session settles again: its WELCOME starts the clock over.
    r.down(LinkKind::tcp);
    r.logs.push(line_of(1));
    r.tcp.sent.clear();
    r.session(LinkKind::tcp);
    alive(r, 2900);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    alive(r, 150);
    CHECK_EQ(texts(r.tcp).size(), 1u);
}

TEST(net_log_paces_20_lines_per_second_burst_20)
{
    LogRig r;
    for (int i = 0; i < 100; ++i) {
        r.logs.push(line_of(i));
    }
    handshake(r);
    // A full bucket: 20 at once.
    CHECK_EQ(texts(r.tcp).size(), 20u);
    // Then one per 50 ms, with the window cleared by a hub frame every 50 ms.
    alive(r, 1000);
    const size_t after_1s = texts(r.tcp).size();
    CHECK(after_1s >= 39 && after_1s <= 41);
    alive(r, 2000);
    const size_t after_3s = texts(r.tcp).size();
    CHECK(after_3s >= 79 && after_3s <= 81);
    // In order, none twice.
    const auto got = texts(r.tcp);
    for (size_t i = 0; i < got.size(); ++i) {
        CHECK_EQ(got[i], line_of(static_cast<int>(i)));
    }
}

TEST(net_log_waits_for_an_empty_tx_fifo)
{
    LogRig r;
    handshake(r);
    r.tcp.queued_bytes = 600;  // frames still in the TX FIFO, not yet handed to lwIP
    r.logs.push(line_of(0));
    r.net.logs_ready();
    r.core.run_ready();
    alive(r, 500);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    // The FIFO drained: the next pass (50 ms at most) sends it.
    r.tcp.queued_bytes = 0;
    alive(r, 50);
    CHECK_EQ(texts(r.tcp).size(), 1u);
}

TEST(net_log_1kb_window_is_cleared_by_a_hub_frame_one_rtt_later)
{
    LogRig r;
    const std::string fill(300, 'x');
    for (int i = 0; i < 6; ++i) {
        r.logs.push("I (5) app: " + std::to_string(i) + fill);
    }
    // The TIME burst's SYNC_REQs come 40 ms after each answer: the session's RTT is 40 ms.
    handshake(r, 40);
    // ~340 B each: three fit the 1 KB window, the fourth waits.
    auto got = logged(r.tcp);
    REQUIRE_EQ(got.size(), 3u);
    const fr::TimeUs sent_at = got.back().at;
    // A hub frame sooner than one RTT after them clears nothing, however long the drain waits for it.
    r.core.advance_ms(30);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(5);
    CHECK_EQ(logged(r.tcp).size(), 3u);
    // One RTT after: cleared, and the next three go.
    r.core.advance_to(sent_at + 40'000);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(50);
    got = logged(r.tcp);
    CHECK_EQ(got.size(), 6u);
    for (const Logged &x : got) {
        // LOG.LINE text of 300+ B: BULK, past the realtime MTU.
        CHECK_EQ(x.flags, wire::kFlagBulk);
    }
}

TEST(net_log_window_rtt_has_a_20ms_floor)
{
    LogRig r;
    const std::string fill(300, 'y');
    for (int i = 0; i < 4; ++i) {
        r.logs.push("W (6) app: " + fill, proto::kKindLogW);
    }
    handshake(r, 0);  // answers back at once: the floor applies
    REQUIRE_EQ(logged(r.tcp).size(), 3u);
    r.core.advance_ms(19);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(40);
    CHECK_EQ(logged(r.tcp).size(), 3u);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());  // now 59 ms after
    r.core.advance_ms(50);
    CHECK_EQ(logged(r.tcp).size(), 4u);
}

TEST(net_log_held_while_tcp_is_wifi_silent)
{
    LogRig r;
    handshake(r);
    r.tcp.sent.clear();
    // Nothing from the hub over TCP for more than 2 intervals: Wi-Fi may be stalled, LOG waits.
    r.core.advance_ms(2100);
    r.logs.push(line_of(0));
    r.net.logs_ready();
    r.core.advance_ms(200);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    // The hub is heard again: it goes.
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(50);
    CHECK_EQ(texts(r.tcp).size(), 1u);
}

TEST(net_log_held_while_a_hook_freezes_tcp)
{
    LogRig r;
    handshake(r);
    r.tcp.sent.clear();
    r.net.ip_block(2);
    r.logs.push(line_of(0));
    r.net.logs_ready();
    r.core.advance_ms(1000);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    r.core.advance_ms(1000);  // the hook ends; the session timed out meanwhile? 2 s < 3.5 intervals: not yet
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(50);
    CHECK_EQ(texts(r.tcp).size(), 1u);
}

TEST(net_log_drops_lines_older_than_30s_and_says_so_once)
{
    LogRig r;
    r.logs.push(line_of(0));
    r.logs.push(line_of(1));
    r.core.advance_ms(20'000);
    r.logs.push(line_of(2));
    r.core.advance_ms(11'000);  // the first two are 31 s old, the third 11 s
    handshake(r);
    const auto got = logged(r.tcp);
    REQUIRE_EQ(got.size(), 2u);
    // One marker line for the drops, where the gap is, then the line young enough.
    CHECK_EQ(got[0].kind, proto::kKindLogW);
    CHECK_EQ(got[0].tag, "fr_net");
    const std::string ms = std::to_string(r.core.now() / 1000);
    CHECK_EQ(got[0].text, "W (" + ms + ") fr_net: 2 log lines dropped");
    CHECK_EQ(got[1].text, line_of(2));
    const auto st = r.net.state().logs;
    CHECK_EQ(st.age_drop, 2u);
    CHECK_EQ(st.rate_drop, 0u);
    CHECK_EQ(st.sent, 2u);
    // No second marker for the same drops.
    r.logs.push(line_of(3));
    r.net.logs_ready();
    alive(r, 100);
    CHECK_EQ(texts(r.tcp).size(), 3u);
}

TEST(net_log_counts_rate_drops_when_an_open_drain_cannot_keep_up)
{
    LogRig r;
    handshake(r);
    // 700 lines at once into an open drain: 20/s carries 620 within the 30 s age limit, not the rest.
    for (int i = 0; i < 700; ++i) {
        r.logs.push(line_of(i));
    }
    r.net.logs_ready();
    alive(r, 36'000);
    const auto st = r.net.state().logs;
    CHECK(st.rate_drop > 50);
    CHECK_EQ(st.age_drop, 0u);
    CHECK_EQ(st.sent, 700 - st.rate_drop + 1);  // the marker line is one of them
    CHECK(r.logs.q.empty());
}

TEST(net_log_line_pushed_into_an_empty_ring_goes_at_once)
{
    LogRig r;
    handshake(r);
    alive(r, 300);
    r.tcp.sent.clear();
    // Pushed on another task: without the wake nothing would look before the next unrelated deadline.
    r.logs.push(line_of(0));
    r.core.run_ready();
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    const fr::TimeUs at = r.core.now();
    r.net.logs_ready();
    r.core.run_ready();
    const auto got = logged(r.tcp);
    REQUIRE_EQ(got.size(), 1u);
    CHECK_EQ(got[0].at, at);
}

TEST(net_log_never_over_serial_or_udp)
{
    LogRig r;
    // A USB node with a serial session only: nothing on serial, however long.
    r.session(LinkKind::serial);
    r.logs.push(line_of(0));
    r.net.logs_ready();
    for (int i = 0; i < 10; ++i) {
        r.core.advance_ms(500);
        r.deliver(LinkKind::serial, r.hub.heartbeat());
    }
    CHECK(r.serial.frames_of(wire::kClsLog).empty());
    // TCP and UDP with udp_ok, the serial session on standby: TCP alone.
    r.udp_ok_session();
    r.deliver(LinkKind::tcp, r.hub.sync_req(1));
    r.deliver(LinkKind::tcp, r.hub.cmd(proto::kPortNode, fr::cap::Node::kCmdGetState));
    r.logs.push(line_of(1));
    r.net.logs_ready();
    alive(r, 100);
    CHECK_EQ(texts(r.tcp).size(), 2u);
    CHECK(r.udp.frames_of(wire::kClsLog).empty());
    CHECK(r.serial.frames_of(wire::kClsLog).empty());
}

TEST(net_log_frame_is_q0_to_the_hub_with_the_level_as_kind)
{
    LogRig r;
    const uint8_t levels[] = {proto::kKindLogE, proto::kKindLogW, proto::kKindLogI, proto::kKindLogD,
                              proto::kKindLogV, 0, 9};
    for (uint8_t lv : levels) {
        r.logs.push("I (1) t: level " + std::to_string(lv), lv, "t");
    }
    handshake(r);
    const auto got = logged(r.tcp);
    REQUIRE_EQ(got.size(), 7u);
    const uint8_t kinds[] = {1, 2, 3, 4, 5, 3, 3};  // an unknown level goes as I
    for (size_t i = 0; i < got.size(); ++i) {
        CHECK_EQ(got[i].kind, kinds[i]);
        CHECK_EQ(got[i].flags, 0);  // Q0: no ACK_REQ, realtime-sized
        CHECK_EQ(got[i].port, proto::kPortNode);
        CHECK_EQ(got[i].dst, proto::kAddrHub);
        CHECK_EQ(got[i].tag, "t");
    }
    // Ordinary seqs, after the frames before them.
    const auto frames = r.tcp.frames_of(wire::kClsLog);
    CHECK_EQ(frames[1].seq, frames[0].seq + 1);
}

TEST(net_log_whole_384_byte_line_and_a_longer_one_cut_on_a_code_point)
{
    LogRig r;
    const std::string whole = "I (7) app: " + std::string(384 - 11, 'a');
    REQUIRE_EQ(whole.size(), 384u);
    r.logs.push(whole);
    // 383 B, then a 2-byte code point that no longer fits: cut before it, never through it.
    const std::string longer = "I (8) app: " + std::string(383 - 11, 'b') + "\xC3\xA9" + "tail";
    r.logs.push(longer);
    // A long tag: cut to 16 B, on a code point (a 3-byte one straddles byte 16).
    r.logs.push("I (9) x: y", proto::kKindLogI, std::string(14, 't') + "\xE2\x82\xAC");
    handshake(r);
    const auto got = logged(r.tcp);
    REQUIRE_EQ(got.size(), 3u);
    CHECK_EQ(got[0].text, whole);
    CHECK_EQ(got[1].text, longer.substr(0, 383));
    CHECK_EQ(got[2].tag, std::string(14, 't'));
    CHECK_EQ(r.net.state().logs.cut, 1u);  // text cuts only
}

TEST(net_log_text_becomes_valid_utf8)
{
    LogRig r;
    // Unicode 3.9 table 3-8 (U+FFFD for maximal subparts), which the hub's decoders apply to the serial copy.
    r.logs.push(std::string("\x61\xF1\x80\x80\xE1\x80\xC2\x62\x80\x63\x80\xBF\x64"));
    // A surrogate, an overlong, a sequence cut by the end of the line, and valid 2-, 3- and 4-byte ones.
    r.logs.push(std::string("\xED\xA0\x80|\xE0\x80\x80|\xC3\xA9\xE2\x82\xAC\xF0\x9F\x98\x80|\xE2\x82"));
    handshake(r);
    const auto got = texts(r.tcp);
    REQUIRE_EQ(got.size(), 2u);
    const std::string R = "\xEF\xBF\xBD";
    CHECK_EQ(got[0], "a" + R + R + R + "b" + R + "c" + R + R + "d");
    CHECK_EQ(got[1], R + R + R + "|" + R + R + R + "|\xC3\xA9\xE2\x82\xAC\xF0\x9F\x98\x80|" + R);
    CHECK_EQ(r.net.state().logs.cut, 0u);
}

TEST(net_log_ring_drops_counted_and_told_in_one_marker_line)
{
    LogRig r;
    handshake(r);
    r.tcp.sent.clear();
    // fr_core's source hands Net its ring's counts from inside pop(), before the next line.
    bool told = false;
    r.logs.on_pop = [&] {
        if (!told) {
            told = true;
            r.net.logs_dropped(5, 1);
        }
    };
    r.logs.push(line_of(0));
    r.net.logs_ready();
    alive(r, 100);
    const auto got = logged(r.tcp);
    REQUIRE_EQ(got.size(), 2u);
    CHECK_EQ(got[0].text.find("fr_net: 5 log lines dropped") != std::string::npos, true);
    CHECK_EQ(got[1].text, line_of(0));
    auto st = r.net.state().logs;
    CHECK_EQ(st.ring_drop, 5u);
    CHECK_EQ(st.cut, 1u);
    CHECK_EQ(st.sent, 2u);
    // Drops while there is no line to send still get their marker.
    r.net.logs_dropped(3, 0);
    r.net.logs_ready();
    alive(r, 100);
    CHECK_EQ(texts(r.tcp).back().find("fr_net: 3 log lines dropped") != std::string::npos, true);
    // diag `stats reset` zeroes them.
    r.net.reset_stats();
    st = r.net.state().logs;
    CHECK_EQ(st.sent + st.ring_drop + st.age_drop + st.rate_drop + st.cut, 0u);
}

TEST(net_log_urgent_event_and_heartbeat_leave_at_once_behind_a_backlog)
{
    LogRig r;
    for (int i = 0; i < 200; ++i) {
        r.logs.push("I (1) app: " + std::string(200, 'z'));
    }
    handshake(r);
    REQUIRE_EQ(logged(r.tcp).size(), 4u);
    // The window is full and the FIFO not empty: the backlog waits, the input does not.
    r.tcp.queued_bytes = 900;
    r.tcp.sent.clear();
    r.udp.sent.clear();
    const fr::TimeUs at = r.core.now();
    const uint8_t fields[] = {0x01};
    r.net.event(1, 1, fr::cap::Priority::realtime, fields, at);
    r.core.run_ready();
    auto ev = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(ev.size(), 1u);
    CHECK_EQ(ev[0].at, at);
    CHECK((ev[0].flags & wire::kFlagUrgent) != 0);
    // The next HEARTBEAT at its time, whatever the backlog.
    r.core.advance_ms(1200);
    CHECK(r.tcp.count(wire::kClsPresence, proto::kKindPresenceHeartbeat) >= 1);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
}

TEST(net_log_detached_source_sends_nothing)
{
    LogRig r;
    r.logs.push(line_of(0));
    r.net.attach_logs(nullptr);
    handshake(r);
    alive(r, 4000);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    CHECK_EQ(r.logs.pops, 0);
}

// ---- the two clocks (review fw-net-1) ----

TEST(net_log_line_stamped_ahead_of_the_core_clock_is_fresh)
{
    // fw-net-1: fr_serial stamped the ring with esp_log's clock, 0.15-0.6 s ahead of the core clock the drain reads,
    // and the unsigned age wrapped to ~49 days: each live line popped at once by an idle drain went as a marker.
    // Ahead by 1 ms (pushed on another task just after the drain read its clock), 250 ms and 570 ms (esp_log's lead
    // on the lab's C3 and C6 pads): each is a fresh line.
    LogRig r;
    handshake(r);
    alive(r, 300);
    r.tcp.sent.clear();
    for (const uint32_t ahead : {1u, 250u, 570u}) {
        const uint32_t stamp = core_ms(r) + ahead;
        r.logs.push("I (" + std::to_string(stamp) + ") fr: alive fw=x ahead=" + std::to_string(ahead),
                    proto::kKindLogI, "fr", stamp);
        r.net.logs_ready();
        r.core.run_ready();  // the wake's pass pops it at once, its stamp still ahead
        alive(r, 100);
    }
    const auto got = texts(r.tcp);
    REQUIRE_EQ(got.size(), 3u);
    CHECK(got[0].ends_with("ahead=1"));
    CHECK(got[1].ends_with("ahead=250"));
    CHECK(got[2].ends_with("ahead=570"));
    const auto st = r.net.state().logs;
    CHECK_EQ(st.age_drop, 0u);
    CHECK_EQ(st.rate_drop, 0u);
    CHECK_EQ(st.sent, 3u);
}

TEST(net_log_held_line_stamped_ahead_waits_and_goes)
{
    // The held line's own age check (a pass that finds it waiting for the FIFO, the window or the bucket) reads the
    // same signed age: a line popped with its stamp ahead and held is sent once it may go, not dropped there.
    LogRig r;
    handshake(r);
    alive(r, 300);
    r.tcp.sent.clear();
    r.tcp.queued_bytes = 600;
    r.logs.push(line_of(0), proto::kKindLogI, "app", core_ms(r) + 400);
    r.net.logs_ready();
    r.core.run_ready();
    alive(r, 200);  // four passes find it held, its stamp still ahead of the clock
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    CHECK(r.logs.q.empty());  // popped: held by the drain, not in the ring
    r.tcp.queued_bytes = 0;
    alive(r, 50);
    const auto got = texts(r.tcp);
    REQUIRE_EQ(got.size(), 1u);
    CHECK_EQ(got[0], line_of(0));
    CHECK_EQ(r.net.state().logs.age_drop + r.net.state().logs.rate_drop, 0u);
}

TEST(net_log_line_stamped_behind_ages_by_its_stamp)
{
    // Behind the core clock the stamp still rules: exactly 30 s old goes, a millisecond more is dropped and told.
    LogRig r;
    handshake(r);
    alive(r, 300);
    r.tcp.sent.clear();
    r.logs.push(line_of(0), proto::kKindLogI, "app", core_ms(r) - 30'001);
    r.logs.push(line_of(1), proto::kKindLogI, "app", core_ms(r) - 30'000);
    r.net.logs_ready();
    r.core.run_ready();
    const auto got = texts(r.tcp);
    REQUIRE_EQ(got.size(), 2u);
    CHECK_EQ(got[0], "W (" + std::to_string(core_ms(r)) + ") fr_net: 1 log lines dropped");
    CHECK_EQ(got[1], line_of(1));
    const auto st = r.net.state().logs;
    CHECK_EQ(st.age_drop, 1u);  // pushed before this session opened the drain
    CHECK_EQ(st.rate_drop, 0u);
}

TEST(net_log_age_is_exact_across_the_u32_ms_wrap)
{
    // 49.7 days up: the core clock's ms no longer fit a u32, and the stamps wrap. Behind a busy FIFO, a line pushed
    // 31 s before the wrap is dropped once 30 s old; one pushed 2 s before it, held, goes 3 s after it: 5 s old,
    // its age read across the wrap.
    LogRig r;
    const fr::TimeUs wrap = (static_cast<fr::TimeUs>(UINT32_MAX) + 1) * 1000;  // u32 ms 0 again
    r.core.advance_to(wrap - 40'000'000);
    handshake(r);
    alive(r, 9'000);
    r.tcp.sent.clear();
    r.tcp.queued_bytes = 600;
    r.logs.push(line_of(0), proto::kKindLogI, "app", core_ms(r));
    alive(r, 29'000);
    r.logs.push(line_of(1), proto::kKindLogI, "app", core_ms(r));
    alive(r, 5'000);
    CHECK(r.tcp.frames_of(wire::kClsLog).empty());
    CHECK_EQ(core_ms(r), 3'000u);
    r.tcp.queued_bytes = 0;
    alive(r, 100);
    const auto got = texts(r.tcp);
    REQUIRE_EQ(got.size(), 2u);
    CHECK(got[0].starts_with("W (30"));  // the pass 3.0-3.05 s after the wrap
    CHECK(got[0].ends_with(") fr_net: 1 log lines dropped"));
    CHECK_EQ(got[1], line_of(1));
}

TEST(net_log_stamp_ahead_across_the_u32_ms_wrap_is_fresh)
{
    // 100 ms before the wrap, a line stamped u32 100 (200 ms ahead, across the wrap) goes at the next pass, before
    // the wrap: an unsigned age read nearly 2^32 ms there and sent a marker instead.
    LogRig r;
    const fr::TimeUs wrap = (static_cast<fr::TimeUs>(UINT32_MAX) + 1) * 1000;
    r.core.advance_to(wrap - 5'000'000);
    handshake(r);
    alive(r, 4'900);
    REQUIRE_EQ(core_ms(r), UINT32_MAX - 99);
    r.tcp.sent.clear();
    r.logs.push(line_of(0), proto::kKindLogI, "app", 100);
    r.net.logs_ready();
    alive(r, 50);  // a pass within 50 ms
    const auto got = logged(r.tcp);
    REQUIRE_EQ(got.size(), 1u);
    CHECK_EQ(got[0].text, line_of(0));
    CHECK(got[0].at < wrap);  // popped before the wrap, its stamp ahead across it
    CHECK_EQ(r.net.state().logs.age_drop + r.net.state().logs.rate_drop, 0u);
}

TEST(net_log_marker_prints_the_clock_the_lines_print)
{
    // On target the lines' text prints esp_log's clock, ahead of the core clock: the marker's `W (<ms>)` is on it
    // too (LogSource::text_ms), so the hub maps every LOG line's `<ms>` the same way; the ages stay on the core clock.
    LogRig r;
    r.logs.text_ahead_ms = 250;
    r.logs.push(line_of(0));
    r.core.advance_ms(31'000);
    handshake(r);
    const auto got = texts(r.tcp);
    REQUIRE_EQ(got.size(), 1u);
    CHECK_EQ(got[0], "W (" + std::to_string(core_ms(r) + 250) + ") fr_net: 1 log lines dropped");
    CHECK_EQ(r.net.state().logs.age_drop, 1u);
}

TEST(net_log_target_stamps_the_ring_on_the_core_clock)
{
    // The target's pieces this suite cannot run: fr_serial's hook stamps the ring with esp_timer (EspCore::now()'s
    // clock), not esp_log_timestamp() (the text's clock, 0.15-0.6 s ahead); fr_core's source gives Net esp_log's
    // clock for the marker. A change back to esp_log's stamp fails here.
    const std::string serial = read("firmware/components/fr_serial/src/serial.cpp");
    const std::string esp_core = read("firmware/components/fr_core/src/esp_core.hpp");
    const std::string core = read("firmware/components/fr_core/src/core.cpp");
    REQUIRE(!serial.empty());
    REQUIRE(!esp_core.empty());
    REQUIRE(!core.empty());
    const std::string net_line = code_of(serial, "void net_line(");
    REQUIRE(!net_line.empty());
    CHECK(net_line.find("static_cast<uint32_t>(esp_timer_get_time() / 1000)") != std::string::npos);
    CHECK(net_line.find("esp_log_timestamp()") == std::string::npos);
    CHECK(esp_core.find("TimeUs now() const override { return esp_timer_get_time(); }") != std::string::npos);
    CHECK(core.find("uint32_t text_ms(uint32_t) const override { return esp_log_timestamp(); }") != std::string::npos);
    // The record carries the stamp pop_net_log hands fr_core's source, which passes it on unchanged.
    CHECK(core.find(".pushed_ms = l.pushed_ms") != std::string::npos);
}

// ---- fr_serial's hook pieces (IDF-free) ----

TEST(net_log_hook_strips_ansi_like_the_hub)
{
    std::string s = "\x1b[0;32mI (12) fr: ready id=x\x1b[0m";
    s.resize(fr::serial::strip_ansi(s.data(), s.size()));
    CHECK_EQ(s, "I (12) fr: ready id=x");
    // Only colour sequences (ESC [ digits ; m) go, as the hub's /\x1b\[[0-9;]*m/ removes; anything else stays.
    std::string t = "a\x1b[2Jb\x1b[mc\x1b";
    t.resize(fr::serial::strip_ansi(t.data(), t.size()));
    CHECK_EQ(t, "a\x1b[2Jbc\x1b");
}

TEST(net_log_hook_parses_the_esp_log_head)
{
    using fr::serial::parse_log_head;
    auto h = parse_log_head("W (437) wifi:wifi certification version: v7.0");
    CHECK_EQ(h.level, 2);
    CHECK_EQ(h.tag, "wifi");
    h = parse_log_head("E (1) fr: boom");
    CHECK_EQ(h.level, 1);
    CHECK_EQ(h.tag, "fr");
    h = parse_log_head("V (12345) my tag: x");
    CHECK_EQ(h.level, 5);
    CHECK_EQ(h.tag, "my tag");
    // Shapes the hub stores as raw: no level.
    for (std::string_view raw : {"ESP-ROM:esp32c6-20220919", "I (x) a: b", "I (1) : b", "I (1) tag", "X (1) a: b",
                                 "I(1) a: b", "", "I"}) {
        CHECK_EQ(parse_log_head(raw).level, 0);
    }
}

TEST(net_log_hook_joins_vprintf_fragments_into_whole_lines)
{
    fr::serial::LineJoiner<2, 64> j;
    std::vector<std::string> lines;
    std::vector<bool> cuts;
    auto emit = [&](char *p, size_t n, bool cut) {
        lines.emplace_back(p, n);
        cuts.push_back(cut);
    };
    const int task_a = 0;
    const int task_b = 0;
    auto feed = [&](const void *key, std::string s) { j.feed(key, s.data(), s.size(), emit); };
    // The Wi-Fi blob prints its line, then the '\n' in a call of its own; another task logs in between.
    feed(&task_a, "I (437) wifi:wifi certification version: v7.0");
    feed(&task_b, "I (438) fr: other\n");
    CHECK_EQ(j.open(), 1u);
    feed(&task_a, "\n");
    REQUIRE_EQ(lines.size(), 2u);
    CHECK_EQ(lines[0], "I (438) fr: other");
    CHECK_EQ(lines[1], "I (437) wifi:wifi certification version: v7.0");
    CHECK_EQ(j.open(), 0u);
    // Several lines in one call, the last one left open.
    lines.clear();
    feed(&task_a, "I (1) a: one\nI (1) a: two\nI (1) a: thr");
    feed(&task_a, "ee\n");
    REQUIRE_EQ(lines.size(), 3u);
    CHECK_EQ(lines[2], "I (1) a: three");
    // A joined line longer than the slot is cut, and says so.
    lines.clear();
    cuts.clear();
    feed(&task_a, std::string(60, 'p'));
    feed(&task_a, std::string(10, 'q') + "\n");
    REQUIRE_EQ(lines.size(), 1u);
    CHECK_EQ(lines[0], std::string(60, 'p') + "qqqq");
    CHECK(cuts[0]);
    // No free slot: a third task's fragment is a line of its own.
    lines.clear();
    const int task_c = 0;
    feed(&task_a, "open a");
    feed(&task_b, "open b");
    feed(&task_c, "open c");
    REQUIRE_EQ(lines.size(), 1u);
    CHECK_EQ(lines[0], "open c");
}

TEST(net_log_hook_lines_reach_the_hub_as_one_frame_each)
{
    // The target's path end to end, but for the ring: vprintf calls -> joiner -> ANSI strip -> head -> the source.
    LogRig r;
    fr::serial::LineJoiner<3, fr::serial::kLogLineMax> j;
    const int task = 0;
    auto hook = [&](std::string s) {
        j.feed(&task, s.data(), s.size(), [&](char *p, size_t n, bool) {
            n = fr::serial::strip_ansi(p, n);
            const std::string_view text(p, n);
            const auto head = fr::serial::parse_log_head(text);
            r.logs.push(std::string(text), head.level != 0 ? head.level : proto::kKindLogI, std::string(head.tag));
        });
    };
    hook("\x1b[0;32mI (437) wifi:wifi certification version: v7.0");
    hook("\x1b[0m\n");
    hook("\x1b[0;33mW (440) fr: ready id=x\x1b[0m\n");
    handshake(r);
    const auto got = logged(r.tcp);
    REQUIRE_EQ(got.size(), 2u);
    CHECK_EQ(got[0].text, "I (437) wifi:wifi certification version: v7.0");
    CHECK_EQ(got[0].tag, "wifi");
    CHECK_EQ(got[0].kind, proto::kKindLogI);
    CHECK_EQ(got[1].text, "W (440) fr: ready id=x");
    CHECK_EQ(got[1].kind, proto::kKindLogW);
}
