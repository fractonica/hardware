// KitLogs (design m2-c2 D20, host side): a node's ESP_LOG lines on the host, in the firmware's own formats, out on
// its serial line and into the ring Net drains as LOG frames over TCP. A line is what esp_log prints without colour:
// `<L> (<ms>) <tag>: <text>`, the ms on the node's core clock (in esp_log_timestamp()'s place: on target that runs
// 0.15-0.6 s ahead of the core clock, here the two are one, as is the ring's push stamp), cut to LOG.LINE.text's
// 384 B on a UTF-8 boundary. The ring keeps the oldest lines (drop-newest, as fr_serial's second ring), 4 KB of text.
#include <algorithm>
#include <cinttypes>

#include "sim/node.hpp"

namespace frsim {

// fr_core's banner (core.cpp: "the C1 contract with the hub and agents"), fr_core's alive line, fr_ota's slot line
// (esp_flash.cpp) and fr_core's OTA decision lines (core.cpp log_ota), exactly as the firmware formats them.
const char *const KitLogs::kReadyFmt = "ready id=%s fw=%s state=%s addr=%04x alias=%s board=%s profile=%s part=%s app=%s ver=%s idf=%s "
                                       "reset=%s slot=%s caps=%u epoch=%u";
const char *const KitLogs::kAliveFmt = "alive fw=%s id=%s uptime_s=%" PRId64 " heap=%" PRIu32 " psram_free_kb=%" PRIu32;
const char *const KitLogs::kSlotOpenFmt = "slot %s open for %u B at %u";
// fr_core's log_ota: one line per OTA decision the node sends (core.cpp), what T-OTA's resume evidence reads.
const char *const KitLogs::kOtaAcceptFmt = "ota: ACCEPT %.*s%s%s";
const char *const KitLogs::kOtaRejectFmt = "ota: REJECT %.*s code=%u%s";
const char *const KitLogs::kOtaResultFmt = "ota: RESULT %.*s outcome=%u reason=%u%s";
const char *const KitLogs::kOtaPhaseFmt = "ota: %s %.*s";

namespace {

/** LOG's kind for an esp_log level letter (schema/protocol.yaml: E 1 ... V 5); 0 for another letter. */
uint8_t level_kind(char level)
{
    switch (level) {
    case 'E':
        return 1;
    case 'W':
        return 2;
    case 'I':
        return 3;
    case 'D':
        return 4;
    case 'V':
        return 5;
    default:
        return 0;
    }
}

/** `s` cut to at most `max` bytes, never inside a UTF-8 sequence. */
std::string_view cut_utf8(std::string_view s, size_t max)
{
    if (s.size() <= max) {
        return s;
    }
    size_t n = max;
    while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80) {
        --n;
    }
    return s.substr(0, n);
}

}  // namespace

KitLogs::KitLogs(fr::Core &core, SerialOut serial) : core_(core), serial_(std::move(serial)) {}

void KitLogs::attach(fr::net::Net &net)
{
    net_ = &net;
    net.attach_logs(this);
}

bool KitLogs::log(char level, std::string_view tag, std::string_view text)
{
    if (level_kind(level) == 0 || tag.empty() || tag.size() > 16 || tag.find(' ') != std::string_view::npos) {
        return false;
    }
    // Formatted on the core task, with its clock: a worker strand's line waits for one coalesced post.
    bool post = false;
    {
        const std::lock_guard lock(mu_);
        pending_.push_back({level, std::string(tag), std::string(text)});
        post = !posted_;
        posted_ = true;
    }
    if (post && !core_.post([this] { flush_pending(); })) {
        const std::lock_guard lock(mu_);
        posted_ = false;  // the next line posts again
    }
    return true;
}

void KitLogs::flush_pending()
{
    std::vector<Pending> lines;
    {
        const std::lock_guard lock(mu_);
        lines.swap(pending_);
        posted_ = false;
    }
    for (const Pending &p : lines) {
        push(p.level, p.tag, p.text);
    }
}

void KitLogs::push(char level, std::string_view tag, std::string_view text)
{
    const uint32_t ms = static_cast<uint32_t>(core_.now() / 1000);
    const std::string whole = sformat("%c (%u) %.*s: %.*s", level, ms, static_cast<int>(tag.size()), tag.data(),
                                      static_cast<int>(text.size()), text.data());
    const std::string_view line = cut_utf8(whole, kLineMax);
    ++stats_.lines;
    if (line.size() < whole.size() && net_ != nullptr) {
        ++stats_.cut;
    }
    if (serial_) {
        serial_(whole);  // the USB line carries it whole, as fr_serial's writer does
    }
    if (net_ == nullptr) {
        return;
    }
    if (ring_bytes_ + line.size() > kRingBytes) {
        ++stats_.ring_drop;  // drop-newest: the boot banner stays
        return;
    }
    const bool was_empty = ring_.empty();
    ring_.push_back({level_kind(level), ms, std::string(tag), std::string(line)});
    ring_bytes_ += line.size();
    if (was_empty) {
        net_->logs_ready();
    }
}

bool KitLogs::start(const NodeSpec &spec, std::span<const uint8_t> running_fw, uint32_t caps, bool radio, const char *slot,
                    const char *reset)
{
    alive_fw_ = hex(running_fw.first(std::min<size_t>(running_fw.size(), 6)));
    id_ = hex(spec.mac);
    alive_ = core_.timer([this] {
        const fr::TimeUs now = core_.now();
        log('I', "fr", sformat(kAliveFmt, alive_fw_.c_str(), id_.c_str(), static_cast<int64_t>(now / 1'000'000), uint32_t{200 * 1024},
                               uint32_t{0}));
        alive_->start(kAliveMs * 1000);
    });
    if (alive_ == nullptr) {
        return false;
    }
    const char *state = spec.addr != fr::proto::kAddrUnassigned ? "PROVISIONED" : "UNASSIGNED";
    log('I', "fr",
        sformat(kReadyFmt, id_.c_str(), alive_fw_.c_str(), state, unsigned{spec.addr}, spec.alias.c_str(), spec.board.c_str(),
                spec.profile.c_str(), "fr-4mb-v1", "fr_node", spec.version.c_str(), "host", reset, slot, caps,
                unsigned{spec.epoch}));
    if (!radio) {
        log('I', "fr", "radio off: no Wi-Fi or ESP-NOW, the hub is reached over serial only");
    }
    alive_->start(kAliveMs * 1000);
    return true;
}

bool KitLogs::set_rate(double lines_per_s)
{
    if (gen_ == nullptr) {
        gen_ = core_.timer([this] {
            log('I', "fr_gen", sformat("gen %u", gen_n_++));
            if (gen_period_us_ != 0) {
                gen_->start(gen_period_us_);
            }
        });
        if (gen_ == nullptr) {
            return false;
        }
    }
    gen_period_us_ = lines_per_s > 0 ? static_cast<uint32_t>(std::max(1'000.0, 1e6 / lines_per_s)) : 0;
    gen_->stop();
    if (gen_period_us_ != 0) {
        gen_->start(gen_period_us_);
    }
    return true;
}

KitLogs::Stats KitLogs::stats() const
{
    return stats_;
}

bool KitLogs::pop(fr::net::LogLine &line, std::span<char> scratch)
{
    // Net's drain counts what the ring refused or cut (net_logs.ring_drop, cut, and the marker line), told here on
    // the core task as fr_core's SerialLogs tells it.
    if (net_ != nullptr && (stats_.ring_drop != told_.ring_drop || stats_.cut != told_.cut)) {
        net_->logs_dropped(stats_.ring_drop - told_.ring_drop, stats_.cut - told_.cut);
        told_ = stats_;
    }
    if (ring_.empty()) {
        return false;
    }
    const Rec &r = ring_.front();
    const size_t tag = std::min(r.tag.size(), scratch.size());
    const size_t text = std::min(r.text.size(), scratch.size() - tag);
    std::copy_n(r.tag.data(), tag, scratch.data());
    std::copy_n(r.text.data(), text, scratch.data() + tag);
    line.level = r.level;
    line.pushed_ms = r.pushed_ms;
    line.tag = std::string_view(scratch.data(), tag);
    line.text = std::string_view(scratch.data() + tag, text);
    ring_bytes_ -= r.text.size();
    ring_.pop_front();
    return true;
}

}  // namespace frsim
