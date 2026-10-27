// fr:realtime
// fr_net core, M2-C2 (design m2-c2 D20, spec 05 §5.7, §5.12.1): LOG frames over TCP. The node's log lines come
// from a LogSource (fr_serial's second ring on target); Net's timer drains them to the hub as LOG frames (kind =
// the level, body LOG.LINE {tag, text}) over a settled TCP session only, at most 20 lines/s, never ahead of other
// TCP frames in the TX FIFO, and with at most 1 KB of LOG in the socket not yet cleared by a hub frame. HELLO says
// net_log while a LogSource is attached (send_hello). Everything runs on the core task; no heap.
//
// The rules, in the order a line meets them:
//   - only over TCP, never serial, UDP or ESP-NOW, and only once the session settled: its get_state answered after
//     a TIME burst (the hub's handshake ends with it), or 3 s after WELCOME; never while TCP is wifi-silent or a
//     hook freezes it. The boot backlog then never competes with the handshake's TIME, describe and get_state;
//   - a line older than 30 s when its turn comes is dropped (age_drop, or rate_drop when the drain was open all
//     along and could not keep up): a USB node's TCP copy must reach the hub inside its 60 s dedup window. Its age
//     is the core clock's ms less its push stamp (on the same clock), as a signed difference: a stamp ahead of the
//     drain's clock is a fresh line;
//   - text and tag become valid UTF-8 (each ill-formed subpart one U+FFFD, as the hub's decoders replace them in
//     the serial copy) and are cut on a code-point boundary to LOG.LINE's 384 and 16 bytes (cut);
//   - 20 lines/s, burst 20, in passes at most every 50 ms;
//   - enqueued only while the TCP TX FIFO is empty (Link::queued() == 0): a LOG frame never waits in front of a
//     later frame there;
//   - each frame's bytes are charged to a 1 KB window, cleared by a hub frame over TCP at least one RTT later (the
//     latest TIME burst's, floor 20 ms), which implies the earlier bytes were ACKed: lwIP has up to 5,760 B in its
//     send buffer that the FIFO's fill never shows, so this is what bounds the LOG ahead of a click.
// Lines dropped (ring, age, rate) are told in one `W (<ms>) fr_net: <n> log lines dropped` line when the drain
// can send again, its `<ms>` on the clock the other lines print (LogSource::text_ms). The LOG path never logs itself.
#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"  // generated fr::proto::LogLine
#include "net_util.hpp"

namespace fr::net {

using namespace fr::wire;
using namespace util;

namespace {

/** A thousandth of a line, in µs, at `per_s` lines a second: the bucket's refill unit. */
constexpr uint32_t us_per_milli_line(uint32_t per_s)
{
    return 1'000'000 / (per_s * 1000);
}

/**
 * A line's age in ms at `now`, from its push stamp on the same clock (LogLine::pushed_ms): the u32 difference
 * taken signed, so a stamp ahead of `now` is age 0, a fresh line, where the unsigned difference wrapped to about
 * 4.29e9 ms and dropped it. A line pushed on another task just after the drain read the clock is 1 ms ahead; a
 * source whose stamps run ahead of the core clock (esp_log's did by 0.15-0.6 s) still has its lines sent. Exact
 * across the u32 ms wrap (49.7 days) for ages under 24.8 days.
 */
uint32_t age_ms(TimeUs now, uint32_t pushed_ms)
{
    const auto age = static_cast<int32_t>(static_cast<uint32_t>(now / 1000) - pushed_ms);
    return age > 0 ? static_cast<uint32_t>(age) : 0;
}

/**
 * One step of a UTF-8 decoder (the WHATWG one, which the hub's TextDecoder and StringDecoder follow): from byte
 * `i`, the length of a valid code point (`valid`), or of the maximal subpart one U+FFFD replaces (at least 1;
 * the byte that broke it is not part of it).
 */
size_t utf8_step(std::string_view in, size_t i, bool &valid)
{
    const auto at = [&](size_t k) { return static_cast<uint8_t>(in[k]); };
    const uint8_t c = at(i);
    valid = false;
    if (c < 0x80) {
        valid = true;
        return 1;
    }
    size_t need = 0;
    uint8_t lo = 0x80;
    uint8_t hi = 0xBF;
    if (c >= 0xC2 && c <= 0xDF) {
        need = 1;
    } else if (c == 0xE0) {
        need = 2;
        lo = 0xA0;
    } else if ((c >= 0xE1 && c <= 0xEC) || c == 0xEE || c == 0xEF) {
        need = 2;
    } else if (c == 0xED) {
        need = 2;
        hi = 0x9F;  // no surrogates
    } else if (c == 0xF0) {
        need = 3;
        lo = 0x90;
    } else if (c >= 0xF1 && c <= 0xF3) {
        need = 3;
    } else if (c == 0xF4) {
        need = 3;
        hi = 0x8F;  // nothing above U+10FFFF
    } else {
        return 1;  // a continuation byte, C0, C1 or F5..FF on its own
    }
    for (size_t k = 1; k <= need; ++k) {
        if (i + k >= in.size()) {
            return k;  // cut short by the end of the line
        }
        const uint8_t x = at(i + k);
        if (x < lo || x > hi) {
            return k;
        }
        lo = 0x80;
        hi = 0xBF;
    }
    valid = true;
    return need + 1;
}

/**
 * `in` as valid UTF-8 into `out`: each ill-formed subpart becomes U+FFFD, and only whole code points are written,
 * so a cut lands on a boundary. Returns the bytes written; `cut` when `in` did not fit.
 */
size_t to_utf8(std::string_view in, std::span<char> out, bool &cut)
{
    static constexpr char kReplacement[] = "\xEF\xBF\xBD";
    size_t o = 0;
    cut = false;
    for (size_t i = 0; i < in.size();) {
        bool valid = false;
        const size_t n = utf8_step(in, i, valid);
        const size_t len = valid ? n : sizeof(kReplacement) - 1;
        if (o + len > out.size()) {
            cut = true;
            break;
        }
        std::memcpy(out.data() + o, valid ? in.data() + i : kReplacement, len);
        o += len;
        i += n;
    }
    return o;
}

}  // namespace

void Net::attach_logs(LogSource *logs)
{
    logs_ = logs;
    log_held_ = false;
    log_ready_ = logs != nullptr;  // its ring may hold the boot backlog already
    arm();
}

void Net::logs_ready()
{
    if (logs_ == nullptr) {
        return;
    }
    log_ready_ = true;
    arm();
}

void Net::logs_dropped(uint32_t ring_drop, uint32_t cut)
{
    // No arm(): a source calls this from inside pop(), and the drain sends the marker on its own pass.
    state_.logs.ring_drop += ring_drop;
    state_.logs.cut += cut;
    log_unreported_ += ring_drop;
}

bool Net::log_settled(TimeUs now) const
{
    if (log_welcome_at_ == kNever) {
        return false;
    }
    return (ls(LinkKind::tcp).time_synced && log_state_answered_) || now - log_welcome_at_ >= ms_us(kLogSettleMs);
}

bool Net::log_open(TimeUs now) const
{
    return logs_ != nullptr && ls(LinkKind::tcp).session && link(LinkKind::tcp) != nullptr && !frozen(LinkKind::tcp) &&
           !wifi_silent() && log_settled(now);
}

bool Net::log_window_full() const
{
    // The next frame: a marker when drops wait to be told (it goes first; under 100 B with its header), else the line
    // held; with neither, any room at all lets the next pass pop a line and try it.
    const size_t next = log_unreported_ > 0 ? kHeaderSize + 96 : log_held_ ? kHeaderSize + log_body_len_ : 1;
    return log_charge_n_ == kLogCharges || log_charged_ + next > kLogWindowBytes;
}

void Net::log_refill(TimeUs now)
{
    constexpr uint32_t kFull = kLogPerS * 1000;
    const TimeUs unit = us_per_milli_line(kLogPerS);
    if (log_tokens_ >= kFull || now < log_refill_at_) {
        log_refill_at_ = now;  // a full bucket banks no time
        return;
    }
    // Whole thousandths only, and the clock moves by what they cost: ticks closer than a unit still add up.
    const TimeUs add = (now - log_refill_at_) / unit;
    log_refill_at_ += add * unit;
    log_tokens_ = static_cast<uint32_t>(std::min<TimeUs>(log_tokens_ + add, kFull));
    if (log_tokens_ == kFull) {
        log_refill_at_ = now;
    }
}

void Net::service_logs(TimeUs now)
{
    if (logs_ == nullptr) {
        return;
    }
    log_refill(now);
    if (!log_open(now)) {
        log_open_since_ = kNever;
        return;
    }
    if (log_open_since_ == kNever) {
        log_open_since_ = now;
    }
    if (now < log_pass_at_) {
        return;
    }
    log_pass_at_ = now + ms_us(kLogPassMs);
    for (;;) {
        // Every pass looks, woken or not: a wake the core could not take (a full post queue) only delays a line
        // to the next tick of anything else (a heartbeat at the latest).
        if (!log_held_ && !log_take(now)) {
            log_ready_ = false;  // the ring is empty: the next line pushed wakes the drain (logs_ready)
        }
        if (log_unreported_ > 0) {
            // The drops go first, where the gap is (or close to it: a ring drop is told at the next pop).
            if (!log_send_marker(now)) {
                return;
            }
            continue;
        }
        if (!log_held_) {
            return;
        }
        const uint32_t held_age = age_ms(now, log_pushed_ms_);
        if (held_age > kLogMaxAgeMs) {
            // It waited out its age here (the window or the bucket kept it).
            log_held_ = false;
            log_drop_aged(now - static_cast<TimeUs>(held_age) * 1000);
            continue;
        }
        if (!log_send(log_level_, std::span<const uint8_t>(reinterpret_cast<const uint8_t *>(log_buf_), log_body_len_),
                      now)) {
            return;  // the bucket, the FIFO or the window: the next pass, or the hub frame that clears it
        }
        log_held_ = false;
    }
}

bool Net::log_take(TimeUs now)
{
    for (;;) {
        LogLine line;
        if (!logs_->pop(line, std::span<char>(log_buf_, sizeof(log_buf_)))) {
            return false;
        }
        const uint32_t age = age_ms(now, line.pushed_ms);
        if (age > kLogMaxAgeMs) {
            log_drop_aged(now - static_cast<TimeUs>(age) * 1000);
            continue;
        }
        // tag and text point into log_buf_, which the body overwrites: both are copied out first.
        bool cut = false;
        const size_t text_len = to_utf8(line.text, std::span<char>(log_text_, sizeof(log_text_)), cut);
        bool tag_cut = false;
        char tag[kLogTagMax];
        const size_t tag_len = to_utf8(line.tag, std::span<char>(tag, sizeof(tag)), tag_cut);
        if (cut) {
            ++state_.logs.cut;
        }
        static_assert(fr::proto::LogLine::kMaxSize <= kLogScratch && kLogTextMax <= sizeof(log_text_));
        Writer w(reinterpret_cast<uint8_t *>(log_buf_), sizeof(log_buf_));
        encode(fr::proto::LogLine{.tag = {tag, tag_len}, .text = {log_text_, text_len}}, w);
        if (w.overflow()) {
            continue;  // cannot happen: LOG.LINE's largest encoding fits the scratch
        }
        log_held_ = true;
        log_level_ = line.level >= fr::proto::kKindLogE && line.level <= fr::proto::kKindLogV ? line.level
                                                                                             : fr::proto::kKindLogI;
        log_pushed_ms_ = line.pushed_ms;
        log_body_len_ = static_cast<uint16_t>(w.size());
        return true;
    }
}

void Net::log_drop_aged(TimeUs pushed_at)
{
    if (log_open_since_ != kNever && log_open_since_ <= pushed_at) {
        ++state_.logs.rate_drop;  // the session could carry it all along: the drain did not keep up
    } else {
        ++state_.logs.age_drop;
    }
    ++log_unreported_;
}

bool Net::log_send(uint8_t level, std::span<const uint8_t> body, TimeUs now)
{
    const size_t len = kHeaderSize + body.size();
    Link *tcp = link(LinkKind::tcp);
    if (log_tokens_ < 1000 || tcp == nullptr || tcp->queued() != 0 || log_charge_n_ == kLogCharges ||
        log_charged_ + len > kLogWindowBytes) {
        return false;
    }
    // Q0 to the hub on port 0, an ordinary seq; BULK above the realtime MTU (05 §5.6).
    auto env = build(len > kRtSize ? kFlagBulk : 0, kClsLog, level, seq_ + 1, fr::proto::kAddrHub,
                     fr::proto::kPortNode, {}, body);
    if (env.empty() || !transmit_on(LinkKind::tcp, env)) {
        return false;
    }
    ++seq_;
    log_tokens_ -= 1000;
    const size_t slot = (log_charge_head_ + log_charge_n_) % kLogCharges;
    log_charge_at_[slot] = now;
    log_charge_len_[slot] = static_cast<uint16_t>(env.size());
    ++log_charge_n_;
    log_charged_ += env.size();
    ++state_.logs.sent;
    return true;
}

bool Net::log_send_marker(TimeUs now)
{
    // The line esp_log would have printed, so the hub stores and parses it like any other: its `<ms>` on the clock
    // the other lines' text prints (esp_log's on target), not the core clock, which runs behind it.
    char text[64];
    const int n = std::snprintf(text, sizeof(text), "W (%" PRIu32 ") fr_net: %" PRIu32 " log lines dropped",
                                logs_->text_ms(static_cast<uint32_t>(now / 1000)), log_unreported_);
    const size_t len = std::min(static_cast<size_t>(std::max(n, 0)), sizeof(text) - 1);
    uint8_t body[fr::proto::LogLine::kMaxSize];
    Writer w(body, sizeof(body));
    encode(fr::proto::LogLine{.tag = "fr_net", .text = {text, len}}, w);
    if (!log_send(fr::proto::kKindLogW, w.bytes(), now)) {
        return false;
    }
    log_unreported_ = 0;
    return true;
}

TimeUs Net::next_log_due() const
{
    if (logs_ == nullptr || (!log_held_ && !log_ready_ && log_unreported_ == 0)) {
        return kNever;
    }
    // A WELCOME, the get_state RESULT, a hub frame after a wifi-silent spell or one clearing the window, and a
    // hook's end all arm() again: none of those needs a deadline here.
    if (!ls(LinkKind::tcp).session || link(LinkKind::tcp) == nullptr || frozen(LinkKind::tcp)) {
        return kNever;
    }
    const TimeUs now = core_.now();
    if (!log_settled(now)) {
        return log_welcome_at_ == kNever ? kNever : log_welcome_at_ + ms_us(kLogSettleMs);
    }
    if (wifi_silent() || log_window_full()) {
        return kNever;
    }
    TimeUs due = log_pass_at_;
    if (log_tokens_ < 1000) {
        due = std::max(due, log_refill_at_ + static_cast<TimeUs>(1000 - log_tokens_) * us_per_milli_line(kLogPerS));
    }
    return due;
}

void Net::log_heard(TimeUs at)
{
    const TimeUs rtt = std::max<TimeUs>(log_rtt_us_, ms_us(kLogRttFloorMs));
    while (log_charge_n_ > 0 && at - log_charge_at_[log_charge_head_] >= rtt) {
        log_charged_ -= log_charge_len_[log_charge_head_];
        log_charge_head_ = (log_charge_head_ + 1) % kLogCharges;
        --log_charge_n_;
    }
}

void Net::log_welcome(TimeUs at)
{
    log_welcome_at_ = at;
    log_ready_ = logs_ != nullptr;  // whatever the ring took while there was no session goes once this one settles
    log_state_answered_ = false;
    log_rtt_new_ = true;
    log_sync_res_at_ = kNever;
}

void Net::log_synced(TimeUs req_at, TimeUs res_at)
{
    // The hub sends a burst's SYNC_REQs one after the other, each once the previous SYNC_RES arrived: the gap
    // from an answer to the next request is a round trip (plus the hub's turnaround). A gap of a second or more
    // starts the next burst, whose least sample replaces the last one's.
    const TimeUs gap = req_at - log_sync_res_at_;
    if (log_sync_res_at_ != kNever && gap >= 0 && gap < 1'000'000) {
        log_rtt_us_ = log_rtt_new_ ? static_cast<uint32_t>(gap) : std::min(log_rtt_us_, static_cast<uint32_t>(gap));
        log_rtt_new_ = false;
    } else {
        log_rtt_new_ = true;
    }
    log_sync_res_at_ = res_at;
}

void Net::log_session_end()
{
    log_welcome_at_ = kNever;
    log_state_answered_ = false;
    log_rtt_us_ = 0;
    log_rtt_new_ = true;
    log_sync_res_at_ = kNever;
    log_charge_head_ = log_charge_n_ = 0;
    log_charged_ = 0;
    log_open_since_ = kNever;
}

}  // namespace fr::net
