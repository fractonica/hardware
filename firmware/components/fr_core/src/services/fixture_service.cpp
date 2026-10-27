// fr:realtime
#include "fr/services/fixture_service.hpp"

#include <algorithm>

// fr::core::link_info(): the hub's last frame and run (LinkInfo::hub_heard_at, hub_epoch) for the D11 release
// rule. core.cpp defines it on target; fr_net_node and the host suite, which host FixtureService without fr_core's
// runtime, define their own, filled the same way (fr::core::hub_link_info).
#include "fr/core/node_net.hpp"

namespace fr {
namespace {

/** While a press runs, the hub is checked at least this often (D11 item 3): a WELCOME of another run. */
constexpr uint32_t kHubCheckUs = 100'000;
/** A refresh of one pixel: led_ws2812 sends one (max_leds = 1); anything else is a bad frame. */
constexpr uint8_t kFrameBits = 24;

/**
 * D11 item 3: how much longer a press that started in hub run `press_epoch` may run on the hub's account; 0 means
 * let go now. It counts from the newest frame the hub sent (its keepalive comes at least once a heartbeat interval,
 * 05 §5.11), not from the session flag, which outlives a dead hub by the session timeout (3.5 intervals) and stays
 * set while `net drop_hub_link` freezes the link. A WELCOME of another hub run ends it at once: the new hub never
 * knew of this press, so nothing would release it before cap_ms.
 */
uint32_t hub_allows_us(TimeUs now, uint16_t press_epoch)
{
    const net::LinkInfo li = core::link_info();
    if (li.hub_epoch != press_epoch) {
        return 0;
    }
    const TimeUs left = li.hub_heard_at + FixtureService::kHubSilentUs - now;
    return left > 0 ? static_cast<uint32_t>(std::min<TimeUs>(left, UINT32_MAX)) : 0;
}

constexpr uint32_t low32(TimeUs t)
{
    return static_cast<uint32_t>(t);
}

/** A line's u32 stamp on the core clock: the stamp is at most ~35 min from `now` (edges reach the core task in
 * milliseconds). Never negative, which would read as kNowUs. */
TimeUs unwrap(uint32_t t, TimeUs now)
{
    const TimeUs at = now - static_cast<int32_t>(low32(now) - t);
    return at < 0 ? 0 : at;
}

bool pending(const cap::FixtureEdges &b)
{
    return b.n > 0 || b.dropped > 0;
}

/** µs until the pending batch is due: flush_us after its last edge, kBatchMaxUs after its first at most. */
uint32_t batch_delay(const cap::FixtureEdges &b, uint32_t first_us, uint16_t flush_us, TimeUs now)
{
    const uint32_t last = b.n > 0 ? b.dt_us[b.n - 1] : 0;
    const uint32_t due = std::min<uint32_t>(FixtureService::kBatchMaxUs, last + flush_us);
    const auto left = static_cast<int32_t>(first_us + due - low32(now));
    return left > 0 ? static_cast<uint32_t>(left) : 0;
}

/** The service's one timer: the pending batch's deadline and, while a press runs, the hub check (`hub_us`, from
 * FixtureService::hub_check_us; UINT32_MAX for none). */
void arm(Timer &t, const cap::FixtureEdges &batch, uint32_t first_us, uint16_t flush_us, uint32_t hub_us, TimeUs now)
{
    uint32_t delay = hub_us;
    if (pending(batch)) {
        delay = std::min(delay, batch_delay(batch, first_us, flush_us, now));
    }
    if (delay == UINT32_MAX) {
        t.stop();
    } else {
        t.start(delay);
    }
}

hal::FixtureDrive drive_of(cap::FixtureDrive d)
{
    switch (d) {
    case cap::FixtureDrive::open_drain:
        return hal::FixtureDrive::open_drain;
    case cap::FixtureDrive::nfet_gate:
        return hal::FixtureDrive::nfet_gate;
    case cap::FixtureDrive::pwm:
        return hal::FixtureDrive::pwm;  // design m2-c3-inputs §3: fixture_gpio's LEDC output
    case cap::FixtureDrive::none:
        break;
    }
    return hal::FixtureDrive::none;
}

hal::FixtureDecode decode_of(cap::FixtureDecode d)
{
    return d == cap::FixtureDecode::ws2812 ? hal::FixtureDecode::ws2812 : hal::FixtureDecode::level;
}

uint16_t add_sat16(uint16_t a, uint32_t b)
{
    return static_cast<uint16_t>(std::min<uint32_t>(UINT16_MAX, uint32_t{a} + std::min<uint32_t>(b, UINT16_MAX)));
}

}  // namespace

FixtureService::FixtureService(hal::FixtureLine &line, const cap::FixtureConfig &cfg) : line_(line), cfg_(cfg)
{
    cfg_.cap_ms = std::clamp<uint16_t>(cfg_.cap_ms, 100, 30000);
    cfg_.flush_us = std::clamp<uint16_t>(cfg_.flush_us, 200, 20000);
    traits_.drive = cfg_.drive;
    traits_.decode = cfg_.decode;
}

Status FixtureService::init(Core &core)
{
    core_ = &core;
    flush_ = core.timer([this] {
        line_.drain();  // what the line captured since its last delivery joins the batch first
        const TimeUs now = core_->now();
        if (pending(batch_) && batch_delay(batch_, batch_first_us_, cfg_.flush_us, now) == 0) {
            flush();
        }
        // D11 item 3: a press never outlives the hub's last frame by more than kHubSilentUs, nor its hub run.
        if (line_.pressing() && hub_allows_us(now, press_epoch_) == 0) {
            (void)line_.release();
        }
        arm(*flush_, batch_, batch_first_us_, cfg_.flush_us, hub_check_us(now), now);
    });
    if (flush_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const hal::FixtureLineMode mode{
        .drive = drive_of(cfg_.drive),
        .decode = decode_of(cfg_.decode),
        .pull_up = cfg_.pull == cap::FixturePull::up,
    };
    if (auto st = line_.init(core, mode, *this); !st) {
        return st;
    }
    duty_ = 0;  // a pwm line starts at duty 0
    level_ = cfg_.drive == cap::FixtureDrive::pwm ? false : line_.level();
    return {};
}

hal::Selftest FixtureService::selftest()
{
    return line_.selftest();
}

std::expected<cap::FixturePressResult, Err> FixtureService::press(const cap::FixturePressArgs &args)
{
    if (cfg_.drive == cap::FixtureDrive::none || cfg_.drive == cap::FixtureDrive::pwm) {
        return std::unexpected(Err::unsupported);
    }
    if (flush_ == nullptr) {
        return std::unexpected(Err::failed);  // init() did not run (the runtime answers FAILED for it anyway)
    }
    const auto segments = args.segments_us.span();
    if (segments.empty() || std::ranges::find(segments, 0u) != segments.end()) {
        return std::unexpected(Err::invalid_args);
    }
    // Released is the idle level: open_drain reads high (nothing holds the DUT's BOOT low, the DUT's own button
    // included), nfet_gate's gate reads low. The line checks again, atomically with starting.
    const bool released = line_.level() == (cfg_.drive == cap::FixtureDrive::open_drain);
    if (line_.pressing() || !released) {
        return std::unexpected(Err::busy);
    }
    const auto r = line_.press(segments, static_cast<uint32_t>(cfg_.cap_ms) * 1000);
    if (!r) {
        return std::unexpected(r.error());
    }
    // The hub run whose CMD this is: a WELCOME of another one releases the line (D11 item 3).
    press_epoch_ = core::link_info().hub_epoch;
    arm(*flush_, batch_, batch_first_us_, cfg_.flush_us, hub_check_us(core_->now()), core_->now());
    return cap::FixturePressResult{.at_us = r->at_us, .total_us = r->total_us};
}

Status FixtureService::release()
{
    auto st = line_.release();
    // A pwm line's release is duty 0 (design m2-c3-inputs §3), reported only once the line took it: a failed LEDC
    // write leaves the duty, and the level reported, as they were.
    if (st && cfg_.drive == cap::FixtureDrive::pwm && flush_ != nullptr) {
        duty_changed(0, cap::kNowUs);
    }
    return st;
}

std::expected<cap::FixtureSetDutyResult, Err> FixtureService::set_duty(const cap::FixtureSetDutyArgs &args)
{
    // Design m2-c3-inputs §3: a pwm line's setpoint, idempotent; any other drive has none.
    if (cfg_.drive != cap::FixtureDrive::pwm) {
        return std::unexpected(Err::unsupported);
    }
    if (args.duty > hal::kFixtureDutyMax) {
        return std::unexpected(Err::invalid_args);
    }
    if (flush_ == nullptr) {
        return std::unexpected(Err::failed);  // init() did not run
    }
    const auto at = line_.set_duty(args.duty);
    if (!at) {
        return std::unexpected(at.error());
    }
    duty_changed(args.duty, unwrap(*at, core_->now()));
    return cap::FixtureSetDutyResult{.at_us = *at};
}

std::expected<cap::FixtureReadResult, Err> FixtureService::read()
{
    line_.drain();
    // A pwm line reads duty > 0 (design m2-c3-inputs §3): its pin is a 20 kHz waveform, not a level.
    const bool lv = cfg_.drive == cap::FixtureDrive::pwm ? duty_ > 0 : line_.level();
    return cap::FixtureReadResult{.level = lv, .edges = edges_, .dropped = dropped_, .bad_frames = bad_frames_};
}

void FixtureService::duty_changed(uint16_t duty, TimeUs at)
{
    duty_ = duty;
    if ((duty > 0) != level_) {
        level_ = duty > 0;
        report_level(level_, at);
    }
}

void FixtureService::on_edges(std::span<const hal::FixtureEdge> edges, uint32_t dropped)
{
    edges_ += static_cast<uint32_t>(edges.size());
    dropped_ += dropped;
    for (const hal::FixtureEdge &e : edges) {
        // A batch spans at most kBatchMaxUs of edge time, however late its edges reach the core task.
        if (batch_.n > 0 && static_cast<int32_t>(e.t_us - batch_first_us_) >= static_cast<int32_t>(kBatchMaxUs)) {
            flush();
        }
        if (batch_.n == 0) {
            batch_first_us_ = e.t_us;
        }
        const auto dt = static_cast<int32_t>(e.t_us - batch_first_us_);
        batch_.dt_us.push_back(dt > 0 ? static_cast<uint32_t>(dt) : 0);
        if (e.level) {
            batch_.levels |= 1u << batch_.n;
        }
        ++batch_.n;
        if (batch_.n == kBatchMax) {
            flush();
        }
    }
    if (dropped > 0) {
        if (!pending(batch_)) {
            batch_first_us_ = low32(core_->now());
        }
        batch_.dropped = add_sat16(batch_.dropped, dropped);
    }
    arm(*flush_, batch_, batch_first_us_, cfg_.flush_us, hub_check_us(core_->now()), core_->now());
}

uint32_t FixtureService::hub_check_us(TimeUs now) const
{
    // The moment the hub's silence reaches kHubSilentUs, and every kHubCheckUs meanwhile for a new hub run.
    return line_.pressing() ? std::min(kHubCheckUs, hub_allows_us(now, press_epoch_)) : UINT32_MAX;
}

void FixtureService::on_frame(const hal::FixtureFrame &frame)
{
    const bool good = frame.bits == kFrameBits;
    if (!good) {
        ++bad_frames_;
    }
    emit_frame({.bits = frame.bits, .grb = good ? frame.grb & 0xFFFFFFu : 0}, unwrap(frame.start_us, core_->now()));
}

void FixtureService::flush()
{
    const TimeUs now = core_->now();
    TimeUs last_at = cap::kNowUs;
    bool last_level = level_;
    if (pending(batch_)) {
        // The event's t_us is the first edge; a batch of overflows alone goes out at its emission.
        const TimeUs at = batch_.n > 0 ? unwrap(batch_first_us_, now) : cap::kNowUs;
        if (batch_.n > 0) {
            last_at = unwrap(batch_first_us_ + batch_.dt_us[batch_.n - 1], now);
            last_level = ((batch_.levels >> (batch_.n - 1)) & 1u) != 0;
        }
        emit_edges(batch_, at);
        batch_ = {};
    }
    // `level` is the pin as it reads now, stamped with the last edge when that edge says the same (a pwm line's is its
    // duty > 0, which duty_changed reports).
    const bool lv = cfg_.drive == cap::FixtureDrive::pwm ? duty_ > 0 : line_.level();
    if (lv != level_) {
        level_ = lv;
        report_level(lv, lv == last_level ? last_at : cap::kNowUs);
    }
}

}  // namespace fr
