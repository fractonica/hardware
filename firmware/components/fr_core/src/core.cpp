// Boot and runtime wiring (spec 03 §3.4-3.5, design c2 §5): identity and epoch, fr_serial and the diag
// channel, the port table with the system capabilities, the C1 banner and the liveness log.
#include "fr/core.hpp"

#include <cinttypes>
#include <cstdio>
#include <cstring>

#include "diag.hpp"  // generated fr::cap::Diag
#include "esp_app_desc.h"
#include "esp_core.hpp"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "fr/diag.hpp"
#include "fr/serial.hpp"
#include "fr/serial_line.hpp"
#include "led.hpp"   // generated fr::cap::Led (identify blinks the first LED)
#include "node.hpp"  // generated fr::cap::Node
#include "nvs_flash.h"
#include "sdkconfig.h"

namespace fr::core {
namespace {

constexpr const char *TAG = "fr";
constexpr uint32_t kAlivePeriodMs = 10000;
// Long enough for the RESULT or diag response to leave through fr_serial before the restart.
constexpr uint32_t kRebootDelayUs = 250'000;
constexpr size_t kMaxPorts = kMaxInstances + 2;  // node + instances + diag
constexpr size_t kRxBufs = 4;
constexpr size_t kRxBufBytes = 256;  // a realtime envelope (250 B MTU) fits
constexpr size_t kLineBufs = 2;
constexpr size_t kLineBytes = 512;  // diag request lines (fr.diag.exec carries at most 200)

fr_identity_t s_identity;
char s_fw_id[13] = "unknown";
EspCore s_core;
EnvelopeLink s_link{s_core, [](std::span<const uint8_t> env) { serial::write_frame(wire::kSerialEnv, env); }};

PortEntry s_ports[kMaxPorts];
diag::PortInfo s_diag_ports[kMaxPorts];
size_t s_nports = 0;
SelftestFn s_selftest = nullptr;

Timer *s_reboot_timer = nullptr;
bool s_reboot_bootloader = false;
uint32_t s_rx_dropped = 0;  // written by the reader task, reset from the core task: a stale read is fine

void load_fw_id()
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    uint8_t sha[32];
    if (running && esp_partition_get_sha256(running, sha) == ESP_OK) {
        snprintf(s_fw_id, sizeof(s_fw_id), "%02x%02x%02x%02x%02x%02x", sha[0], sha[1], sha[2], sha[3], sha[4],
                 sha[5]);
    }
}

void report_all_ports()
{
    for (size_t i = 0; i < s_nports; ++i) {
        if (s_ports[i].cap != nullptr && s_ports[i].ok) {
            s_ports[i].cap->report_all();
        }
    }
}

void schedule_reboot(bool bootloader)
{
    s_reboot_bootloader = bootloader;
    if (s_reboot_timer == nullptr) {
        diag::restart(bootloader);
    }
    s_reboot_timer->start(kRebootDelayUs);
}

// ---- system capabilities ----

/** fr.node on port 0. C2 implements identify, reboot and get_state; the rest arrives with C3+. */
class NodeService final : public cap::Node
{
public:
    Status identify(const cap::NodeIdentifyArgs &args) override
    {
        // Blink the first working LED for about `ms`; a node without one just logs.
        ESP_LOGI(TAG, "identify %u ms", static_cast<unsigned>(args.ms));
        for (size_t i = 0; i < s_nports; ++i) {
            const PortEntry &p = s_ports[i];
            if (p.ok && p.cap != nullptr && p.cap->cap_id() == cap::Led::kId) {
                cap::LedBlinkArgs b;
                b.on_ms = 100;
                b.off_ms = 100;
                b.count = static_cast<uint16_t>(args.ms / 200 > 0 ? args.ms / 200 : 1);
                return static_cast<cap::Led *>(p.cap)->blink(b);
            }
        }
        return {};
    }
    // The schema gives describe no result fields yet, so the descriptor (07 §7.4) has no way back.
    Status describe() override { return std::unexpected(Err::unsupported); }
    Status reboot(const cap::NodeRebootArgs &args) override
    {
        if (args.bootloader && !diag::can_enter_bootloader()) {
            return std::unexpected(Err::unsupported);
        }
        schedule_reboot(args.bootloader);
        return {};
    }
    Status set_alias(const cap::NodeSetAliasArgs &) override { return std::unexpected(Err::unsupported); }
    Status set_groups(const cap::NodeSetGroupsArgs &) override { return std::unexpected(Err::unsupported); }
    Status net_set(const cap::NodeNetSetArgs &) override { return std::unexpected(Err::unsupported); }
    Status get_state() override
    {
        report_all_ports();
        return {};
    }
    Status bind_set() override { return std::unexpected(Err::unsupported); }
    Status bind_clear(const cap::NodeBindClearArgs &) override { return std::unexpected(Err::unsupported); }
    Status bind_list() override { return std::unexpected(Err::unsupported); }
};

/** fr.diag on port 241: the serial command channel's commands as a capability. */
class DiagService final : public cap::Diag
{
public:
    std::expected<cap::DiagExecResult, Err> exec(const cap::DiagExecArgs &args) override;

private:
    char out_[cap::DiagExecResult::kMaxSize];
};

NodeService s_node;
DiagService s_diag;

class RuntimeHost final : public diag::Host
{
public:
    const fr_identity_t &identity() const override { return s_identity; }
    const char *fw_id() const override { return s_fw_id; }
    std::span<const diag::PortInfo> ports() const override { return {s_diag_ports, s_nports}; }
    bool selftest(const char *name, diag::SelftestResult &out) override
    {
        for (size_t i = 0; i < s_nports; ++i) {
            if (std::strcmp(s_ports[i].name, name) == 0) {
                if (s_selftest == nullptr) {
                    out = {false, "no self-test"};
                } else {
                    hal::Selftest r = s_selftest(name);
                    out = {r.ok, r.detail};
                }
                return true;
            }
        }
        return false;
    }
    cap::Sink &sink() override { return s_link; }
    diag::RuntimeStats runtime_stats() const override
    {
        const EnvelopeLink::Stats &l = s_link.stats();
        return {.cmds = l.cmds,
                .env_ignored = l.ignored,
                .env_bad = l.bad,
                .rx_dropped = s_rx_dropped,
                .posts_dropped = s_core.posts_dropped()};
    }
    void reset_runtime_stats() override
    {
        s_link.reset_stats();
        s_rx_dropped = 0;
        s_core.reset_posts_dropped();
    }
    void reboot(bool bootloader) override { schedule_reboot(bootloader); }
};

RuntimeHost s_host;

std::expected<cap::DiagExecResult, Err> DiagService::exec(const cap::DiagExecArgs &args)
{
    // `call diag.exec` inside an exec line would recurse through execute() on the core task's 6 KB stack
    // (and reuse out_), one level per nested line. One level is all the channel needs.
    static bool s_in_exec = false;  // core task only
    if (s_in_exec) {
        return std::unexpected(Err::busy);
    }
    s_in_exec = true;
    size_t n = diag::execute(args.line, s_host, out_);
    s_in_exec = false;
    if (n == 0) {
        return std::unexpected(Err::invalid_args);  // a blank line has no answer
    }
    return cap::DiagExecResult{.json = {out_, n}};
}

// ---- serial input (fr_serial reader task) ----

/** Fixed buffers lent to the core task with each posted line; never more in flight than the pool. */
template <size_t Bytes>
struct Buf {
    bool busy = false;
    size_t len = 0;
    uint8_t bytes[Bytes];
};

portMUX_TYPE s_buf_mux = portMUX_INITIALIZER_UNLOCKED;
Buf<kRxBufBytes> s_rx_bufs[kRxBufs];
Buf<kLineBytes> s_line_bufs[kLineBufs];

template <size_t Bytes, size_t N>
Buf<Bytes> *acquire(Buf<Bytes> (&pool)[N])
{
    Buf<Bytes> *b = nullptr;
    portENTER_CRITICAL(&s_buf_mux);
    for (auto &candidate : pool) {
        if (!candidate.busy) {
            candidate.busy = true;
            b = &candidate;
            break;
        }
    }
    portEXIT_CRITICAL(&s_buf_mux);
    return b;
}

template <size_t Bytes>
void release(Buf<Bytes> *b)
{
    portENTER_CRITICAL(&s_buf_mux);
    b->busy = false;
    portEXIT_CRITICAL(&s_buf_mux);
}

bool on_frame_line(std::string_view line)
{
    static uint8_t scratch[wire::kMaxLineFrame];  // the reader task is the only caller
    auto frame = wire::decode_line(line, scratch);
    if (!frame) {
        return false;
    }
    if (frame->type != wire::kSerialEnv) {
        return true;  // GW_* and LINK_* frames are for a gateway (M2)
    }
    Buf<kRxBufBytes> *b = frame->body.size() <= kRxBufBytes ? acquire(s_rx_bufs) : nullptr;
    if (b == nullptr) {
        ++s_rx_dropped;
        return true;
    }
    std::memcpy(b->bytes, frame->body.data(), frame->body.size());
    b->len = frame->body.size();
    if (!s_core.post([b] {
            s_link.receive({b->bytes, b->len});
            release(b);
        })) {
        release(b);
        ++s_rx_dropped;
    }
    return true;
}

/** Answers a request the core task never saw (no buffer, queue full), keeping its `#<id>`. */
void reject_line(std::string_view line, const char *error, const char *detail)
{
    size_t id_len = 0;
    if (!line.empty() && line.front() == '#') {
        while (id_len + 1 < line.size() && id_len < 8 && line[id_len + 1] >= '0' && line[id_len + 1] <= '9') {
            ++id_len;
        }
    }
    char out[128];
    int n = id_len > 0 ? snprintf(out, sizeof(out), "#%.*s {\"ok\":false,\"error\":\"%s\",\"detail\":\"%s\"}",
                                  static_cast<int>(id_len), line.data() + 1, error, detail)
                       : snprintf(out, sizeof(out), "{\"ok\":false,\"error\":\"%s\",\"detail\":\"%s\"}", error, detail);
    if (n > 0) {
        serial::write_line({out, static_cast<size_t>(n) < sizeof(out) ? static_cast<size_t>(n) : sizeof(out) - 1});
    }
}

void on_text_line(std::string_view line)
{
    if (line.size() > kLineBytes) {
        ++s_rx_dropped;
        reject_line(line, "invalid_args", "request line too long");
        return;
    }
    Buf<kLineBytes> *b = acquire(s_line_bufs);
    if (b == nullptr) {
        ++s_rx_dropped;
        reject_line(line, "busy", "previous requests still running");
        return;
    }
    std::memcpy(b->bytes, line.data(), line.size());
    b->len = line.size();
    bool posted = s_core.post([b] {
        static char out[wire::kMaxLine];  // core task only
        size_t n = diag::execute({reinterpret_cast<const char *>(b->bytes), b->len}, s_host, out);
        release(b);
        if (n > 0) {
            serial::write_line({out, n});
        }
    });
    if (!posted) {
        release(b);
        ++s_rx_dropped;
        reject_line(line, "busy", "core queue full");
    }
}

[[noreturn]] void alive_loop()
{
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(kAlivePeriodMs));
        ESP_LOGI(TAG, "alive id=%s uptime_s=%" PRId64 " heap=%" PRIu32, s_identity.device_id,
                 esp_timer_get_time() / 1000000, static_cast<uint32_t>(esp_get_free_heap_size()));
    }
}

}  // namespace

Core &start()
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // Unusable as it is. Erasing loses the stored epoch; epoch_floor and the hub's epoch_regressed
        // handling (05 §5.8) cover that.
        ESP_LOGW(TAG, "nvs: %s, erasing", esp_err_to_name(err));
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_flash_init: %s", esp_err_to_name(err));
    }
    fr_id_load(&s_identity);
    // Before anything can transmit (05 §5.5): frames only start once the core task runs.
    fr_id_commit_boot_epoch(&s_identity);
    load_fw_id();
    s_link.set_origin({.net = s_identity.net, .addr = s_identity.addr, .epoch = s_identity.epoch});
    // Taken before fr::board::init can drain the timer pool, so `reboot` always answers before it
    // restarts. Without the wake-up alarm the timer would never fire: reboot then restarts at once.
    if (s_core.begin()) {
        s_reboot_timer = s_core.timer([] { diag::restart(s_reboot_bootloader); });
    }
    if (!serial::start({.frame = on_frame_line, .text = on_text_line})) {
        ESP_LOGE(TAG, "fr_serial did not start: no frames and no diag channel this boot");
    }
    return s_core;
}

cap::Sink &sink()
{
    return s_link;
}

void run_ports(std::span<const PortEntry> instances, SelftestFn selftest, size_t left_out)
{
    s_selftest = selftest;
    size_t n = 0;
    s_ports[n++] = {diag::kPortNode, "node", &s_node, true};
    for (const PortEntry &p : instances) {
        if (n == kMaxPorts - 1) {
            ++left_out;
            continue;
        }
        s_ports[n++] = p;
    }
    s_ports[n++] = {diag::kPortDiag, "diag", &s_diag, true};
    size_t caps = n - 2;
    for (size_t i = 0; i < n; ++i) {
        PortEntry &p = s_ports[i];
        // fr::board::attach normally did this already; a capability left unattached would drop its
        // emissions (Capability::port() is 0xFF until attached).
        if (p.cap != nullptr && p.cap->port() == 0xFF) {
            p.cap->attach(p.port, p.name, s_link);
        }
        s_diag_ports[i] = {p.port, p.name, p.cap, p.ok};
        if (!p.ok) {
            ESP_LOGE(TAG, "port %u (%s) failed init; its commands answer FAILED", p.port, p.name);
        }
    }
    if (left_out > 0) {
        ESP_LOGE(TAG, "%u instances beyond the %u-port table were left out", static_cast<unsigned>(left_out),
                 static_cast<unsigned>(kMaxInstances));
    }
    s_nports = n;
    s_link.set_ports({s_ports, n});
    // The first thing the core task does: every property once, so the hub's view starts complete.
    s_core.post([] { report_all_ports(); });

    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    // The banner is the C1 contract with the hub and agents (`fr wait log "fr: ready id=<id>"`): fields
    // may be appended, never removed or reordered.
    ESP_LOGI(TAG,
             "ready id=%s fw=%s state=%s addr=%04x alias=%s board=%s profile=%s part=%s app=%s ver=%s idf=%s "
             "reset=%s slot=%s caps=%u epoch=%u",
             s_identity.device_id, s_fw_id, fr_id_state_name(s_identity.state), s_identity.addr, s_identity.alias,
             s_identity.board, s_identity.profile, CONFIG_FR_PART_PROFILE, app->project_name, app->version,
             app->idf_ver, diag::reset_reason(), running ? running->label : "?", static_cast<unsigned>(caps),
             static_cast<unsigned>(s_identity.epoch));
    if (!s_core.run()) {
        ESP_LOGE(TAG, "no core task: capabilities will not run");
    }
    alive_loop();
}

const fr_identity_t &identity()
{
    return s_identity;
}

const char *fw_id()
{
    return s_fw_id;
}

}  // namespace fr::core
