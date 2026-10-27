// fr:realtime
// The ESP-NOW driver (design c5 §3, spec 05 §5.3): AirLink on the STA interface. esp_now_init runs after
// esp_wifi_start (start_air() after start()); the broadcast peer is added then, unicast peers on demand by
// the scheduler (air_sched.hpp: LRU, at most 17, plus the chosen gateway pinned; a gateway's LRU 19), each followed by esp_now_set_peer_rate_config at the
// robust rate. Every peer has channel 0, so it follows the radio, which the STA keeps on channel C.
//
// Three contexts meet here and only copy and post (05 §5.3, 03 §3.4):
//   - the Wi-Fi task runs the receive callback (filter, copy into the receive ring) and the send callback
//     (a verdict, counted: the scheduler matches verdicts to its sends by count, as the driver calls them in
//     send order);
//   - the esp_timer task runs the retry/guard timer;
//   - the core task runs service(), posted by any of them, which hands received envelopes to Net (and then
//     takes Net's word on when a neighbour last reported Wi-Fi up, for the STA's sweep rule), feeds the
//     verdicts and timer to the scheduler, and through it starts the next send.
// Posts coalesce (one service in the core queue at a time); a post refused by a full queue is offered again
// from an esp_timer 1 ms later, so a verdict is never lost. No heap.
//
// M2-C4 (design m2-c4-gateway D1, D8, D19): a frame may name its rate (send_at; the scheduler sets it on the peer, the
// fast one being 11g 6 Mbps), a send's end tells its link retries and queue wait (done_info), received frames carry
// their receive stamp, and the S2 hooks `air rate` and `air churn` run here (air_set_rate, air_churn).
#include <atomic>
#include <cstring>

#include "air_detail.hpp"
#include "air_sched.hpp"
#include "esp_log.h"
#include "esp_now.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "fr/envelope.hpp"
#include "fr/net/esp.hpp"

namespace fr::net::esp {
namespace {

constexpr const char *TAG = "fr_net";
// Received frames between the Wi-Fi task and the core task (16 x 250 B): a flood burst from a few
// neighbours fits while the core task handles an input.
constexpr size_t kRxSlots = 16;
// Frames handed to Net per service; then the other posted work gets its turn and the service comes again.
constexpr size_t kRxPerService = 4;
constexpr uint64_t kPostRetryUs = 1'000;
// Envelope v1 (05 §5.6): magic_ver, flags, cls, kind, seq u32, then net u16 LE.
constexpr size_t kNetOffset = 8;

struct RxSlot {
    uint8_t len = 0;
    RxMeta meta{};
    uint8_t bytes[air::kMtu] = {};
};

// Written once by start_air() before the callbacks are registered.
AirHooks s_hooks{};
esp_timer_handle_t s_timer = nullptr;       // link retries and the send guard (the scheduler's one timer)
esp_timer_handle_t s_post_timer = nullptr;  // offers the service again after a full core queue

std::atomic<bool> s_started{false};
std::atomic<bool> s_up{false};
std::atomic<uint16_t> s_net{0};
std::atomic<uint8_t> s_channel{0};     // C; 0: unknown, no channel filter
std::atomic<uint32_t> s_heard_s{0};    // stamp_s of the last frame that passed the filter
std::atomic<uint32_t> s_wifi_up_s{0};  // stamp_s of Net's wifi_up_neighbor_heard_at (core task writes)

// Single producer (Wi-Fi task), single consumer (core task).
RxSlot s_rx[kRxSlots];
std::atomic<uint32_t> s_rx_head{0};
std::atomic<uint32_t> s_rx_tail{0};

// Mailboxes for service(): the send callbacks' verdicts (their count << 1 | the last one sent), the timer, up().
std::atomic<uint32_t> s_verdicts{0};
std::atomic<bool> s_timer_due{false};
std::atomic<bool> s_up_changed{false};
std::atomic<bool> s_posted{false};

std::atomic<uint32_t> s_rx_ok{0};
std::atomic<uint32_t> s_rx_bad{0};
std::atomic<uint32_t> s_rx_lost{0};
std::atomic<uint32_t> s_rate_fail{0};
uint32_t s_refused_down = 0;  // core task

void service();

/** Any task: one service() in the core queue. */
void request_service()
{
    if (s_posted.exchange(true, std::memory_order_acq_rel)) {
        return;  // the queued one sees this work too: it clears s_posted before it looks
    }
    if (s_hooks.post == nullptr || !s_hooks.post([] { service(); })) {
        s_posted.store(false, std::memory_order_release);
        if (s_post_timer != nullptr) {
            esp_timer_start_once(s_post_timer, kPostRetryUs);  // INVALID_STATE while it runs: one is enough
        }
    }
}

/** AirLink::up(): ESP-NOW started and channel C known. Any task. */
void update_up()
{
    const bool up = s_started.load(std::memory_order_acquire) && s_channel.load(std::memory_order_acquire) != 0;
    if (s_up.exchange(up, std::memory_order_acq_rel) != up) {
        s_up_changed.store(true, std::memory_order_release);
        request_service();
    }
}

/**
 * 05 §5.3: the robust profile (11b 1 Mbps long preamble), set after every add_peer (the rate belongs to the peer entry,
 * the broadcast peer's included); `fast` is 11g 6 Mbps OFDM (design m2-c4-gateway D19 (c)). Never a zero phymode: 0 is
 * WIFI_PHY_MODE_LR, which receivers outside LR cannot hear. False on error: the peer keeps the rate it had.
 */
bool config_rate(const uint8_t *mac, AirRate rate)
{
    const bool fast = rate == AirRate::fast;
    esp_now_rate_config_t rc;
    std::memset(&rc, 0, sizeof(rc));
    rc.phymode = fast ? WIFI_PHY_MODE_11G : WIFI_PHY_MODE_11B;
    rc.rate = fast ? WIFI_PHY_RATE_6M : WIFI_PHY_RATE_1M_L;
    rc.ersu = false;
    rc.dcm = false;
    return esp_now_set_peer_rate_config(mac, &rc) == ESP_OK;
}

/** The robust rate after an add_peer; on error the peer keeps the driver's default rate, counted. */
void set_rate(const uint8_t *mac)
{
    if (!config_rate(mac, AirRate::robust) && s_rate_fail.fetch_add(1, std::memory_order_relaxed) == 0) {
        ESP_LOGW(TAG, "espnow: peer rate not set; the driver default stays");
    }
}

bool add_peer_entry(const uint8_t *mac)
{
    esp_now_peer_info_t p;
    std::memset(&p, 0, sizeof(p));
    std::memcpy(p.peer_addr, mac, ESP_NOW_ETH_ALEN);
    p.channel = 0;  // 05 §5.3: follow the current channel; a non-zero one must equal it
    p.ifidx = WIFI_IF_STA;
    p.encrypt = false;  // never (design c5 §1)
    esp_err_t err = esp_now_add_peer(&p);
    if (err != ESP_OK && err != ESP_ERR_ESPNOW_EXIST) {
        ESP_LOGW(TAG, "espnow: peer %02x%02x%02x%02x%02x%02x not added (%s)", mac[0], mac[1], mac[2], mac[3], mac[4],
                 mac[5], esp_err_to_name(err));
        return false;
    }
    set_rate(mac);
    return true;
}

/** The scheduler's radio: esp_now_* and the esp_timer, called on the core task. */
class EspRadio final : public air::Radio
{
public:
    bool add_peer(const Mac &mac) override { return add_peer_entry(mac.data()); }
    void del_peer(const Mac &mac) override { esp_now_del_peer(mac.data()); }
    bool transmit(const Mac &dst, std::span<const uint8_t> frame) override
    {
        return esp_now_send(dst.data(), frame.data(), frame.size()) == ESP_OK;
    }
    void arm(uint32_t delay_us) override
    {
        esp_timer_stop(s_timer);  // INVALID_STATE when idle: fine
        esp_timer_start_once(s_timer, delay_us);
    }
    void disarm() override { esp_timer_stop(s_timer); }
    void done(uint32_t token, bool ok) override
    {
        if (s_hooks.sent != nullptr) {
            s_hooks.sent(token, ok);
        }
    }
    bool set_rate(const Mac &mac, AirRate rate) override { return config_rate(mac.data(), rate); }
};

EspRadio s_radio;
air::Scheduler s_sched{s_radio};

class EspAir final : public AirLink
{
public:
    bool up() const override { return s_up.load(std::memory_order_acquire); }
    fr::Status send(const Mac &dst, std::span<const uint8_t> envelope, AirPrio prio, uint32_t token) override
    {
        if (!up()) {
            ++s_refused_down;
            return std::unexpected(Err::failed);
        }
        return s_sched.send(dst, envelope, prio, token, esp_timer_get_time());
    }
    fr::Status send_at(const Mac &dst, std::span<const uint8_t> envelope, AirPrio prio, uint32_t token,
                       AirRate rate) override
    {
        if (!up()) {
            ++s_refused_down;
            return std::unexpected(Err::failed);
        }
        return s_sched.send(dst, envelope, prio, token, esp_timer_get_time(), rate);
    }
    AirDone done_info(uint32_t token) const override { return s_sched.last_done(token); }
    bool refused_no_peer() const override { return s_sched.refused_no_peer(); }
    bool pin_peer(const Mac *mac) override { return s_sched.pin(mac, esp_timer_get_time()); }
    void bridge_peers() override { s_sched.set_bridge(true); }
};

EspAir s_air;

/** Core task, posted. */
void service()
{
    s_posted.store(false, std::memory_order_release);  // a callback from here on posts again
    const TimeUs now = esp_timer_get_time();
    if (s_up_changed.exchange(false, std::memory_order_acq_rel) && s_hooks.changed != nullptr) {
        s_hooks.changed();
    }
    // The verdicts before the timer: a stale timer then finds the frame's state moved on and is ignored.
    if (const uint32_t v = s_verdicts.exchange(0, std::memory_order_acq_rel); v != 0) {
        s_sched.sent(v >> 1, (v & 1) != 0, now);
    }
    if (s_timer_due.exchange(false, std::memory_order_acq_rel)) {
        s_sched.timer(now);
    }
    uint32_t tail = s_rx_tail.load(std::memory_order_relaxed);
    size_t n = 0;
    for (; n < kRxPerService && tail != s_rx_head.load(std::memory_order_acquire); ++n) {
        const RxSlot &slot = s_rx[tail % kRxSlots];
        if (s_hooks.received != nullptr) {
            s_hooks.received({slot.bytes, slot.len}, slot.meta);  // Net copies what it keeps
        }
        s_rx_tail.store(++tail, std::memory_order_release);
    }
    if (n > 0 && s_hooks.wifi_up_heard_at != nullptr) {
        s_wifi_up_s.store(detail::stamp_s(s_hooks.wifi_up_heard_at()), std::memory_order_relaxed);
    }
    if (tail != s_rx_head.load(std::memory_order_acquire)) {
        request_service();
    }
}

// ---- callbacks (Wi-Fi task, esp_timer task): copy and post only ----

void on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
{
    // 05 §5.3 receive filter, in order: channel C, magic/version, net. Realtime frames only (<= 250 B).
    if (info == nullptr || info->src_addr == nullptr || data == nullptr || len < static_cast<int>(wire::kHeaderSize) ||
        len > static_cast<int>(air::kMtu)) {
        s_rx_bad.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    const uint8_t home = s_channel.load(std::memory_order_relaxed);
    const uint8_t ch = info->rx_ctrl != nullptr ? static_cast<uint8_t>(info->rx_ctrl->channel) : 0;
    const uint16_t net = static_cast<uint16_t>(data[kNetOffset] | data[kNetOffset + 1] << 8);
    if ((home != 0 && ch != home) || data[0] != wire::kMagicVer || net != s_net.load(std::memory_order_relaxed)) {
        s_rx_bad.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    const uint32_t head = s_rx_head.load(std::memory_order_relaxed);
    if (head - s_rx_tail.load(std::memory_order_acquire) >= kRxSlots) {
        s_rx_lost.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    RxSlot &slot = s_rx[head % kRxSlots];
    slot.len = static_cast<uint8_t>(len);
    std::memcpy(slot.bytes, data, static_cast<size_t>(len));
    std::memcpy(slot.meta.src_mac.data(), info->src_addr, slot.meta.src_mac.size());
    slot.meta.to_broadcast =
        info->des_addr != nullptr && std::memcmp(info->des_addr, kBroadcastMac.data(), kBroadcastMac.size()) == 0;
    slot.meta.rssi = info->rx_ctrl != nullptr ? static_cast<int8_t>(info->rx_ctrl->rssi) : 0;
    slot.meta.channel = ch;
    slot.meta.rx_at = esp_timer_get_time();  // GW_RX rx_ts_us, and the gateway session's TIME t2 (design m2-c4 D8, D10)
    s_rx_head.store(head + 1, std::memory_order_release);
    s_rx_ok.fetch_add(1, std::memory_order_relaxed);
    s_heard_s.store(detail::stamp_s(esp_timer_get_time()), std::memory_order_relaxed);
    request_service();
}

void on_sent(const esp_now_send_info_t *tx_info, esp_now_send_status_t status)
{
    // tx_info's addresses cannot tell a frame from its own retry: the count and the order do (air_sched.hpp).
    static_cast<void>(tx_info);
    const uint32_t ok = status == ESP_NOW_SEND_SUCCESS ? 1 : 0;
    uint32_t v = s_verdicts.load(std::memory_order_relaxed);
    while (!s_verdicts.compare_exchange_weak(v, ((v >> 1) + 1) << 1 | ok, std::memory_order_acq_rel,
                                             std::memory_order_relaxed)) {
    }
    request_service();
}

void on_timer(void *)
{
    s_timer_due.store(true, std::memory_order_release);
    request_service();
}

void on_post_timer(void *)
{
    request_service();
}

bool make_timer(void (*cb)(void *), const char *name, esp_timer_handle_t &out)
{
    const esp_timer_create_args_t args = {
        .callback = cb,
        .arg = nullptr,
        .dispatch_method = ESP_TIMER_TASK,
        .name = name,
        .skip_unhandled_events = true,
    };
    esp_err_t err = esp_timer_create(&args, &out);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "espnow: esp_timer_create: %s", esp_err_to_name(err));
        return false;
    }
    return true;
}

}  // namespace

namespace detail {

void air_set_channel(uint8_t channel)
{
    s_channel.store(channel, std::memory_order_release);
    update_up();
}

uint32_t air_last_heard_s()
{
    return s_heard_s.load(std::memory_order_relaxed);
}

uint32_t air_wifi_up_heard_s()
{
    return s_wifi_up_s.load(std::memory_order_relaxed);
}

}  // namespace detail

AirLink &air_link()
{
    return s_air;
}

bool start_air(const AirSettings &settings, const AirHooks &hooks)
{
    if (s_started.load(std::memory_order_acquire)) {
        return true;
    }
    s_hooks = hooks;
    s_net.store(settings.net, std::memory_order_relaxed);
    if (!make_timer(on_timer, "fr_air", s_timer) || !make_timer(on_post_timer, "fr_air_post", s_post_timer)) {
        return false;
    }
    esp_err_t err = esp_now_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "espnow: esp_now_init: %s", esp_err_to_name(err));
        return false;
    }
    if ((err = esp_now_register_recv_cb(on_recv)) != ESP_OK || (err = esp_now_register_send_cb(on_sent)) != ESP_OK) {
        ESP_LOGE(TAG, "espnow: callbacks not registered: %s", esp_err_to_name(err));
        esp_now_deinit();
        return false;
    }
    // Floods, heartbeats and node broadcasts go to it (05 §5.9); receivers need no peer entry.
    if (!add_peer_entry(kBroadcastMac.data())) {
        esp_now_deinit();
        return false;
    }
    uint32_t version = 0;
    esp_now_get_version(&version);
    s_started.store(true, std::memory_order_release);
    update_up();
    ESP_LOGI(TAG, "espnow: started (v%u, net %u, channel %u, 11b 1 Mbps)", static_cast<unsigned>(version),
             static_cast<unsigned>(settings.net), static_cast<unsigned>(s_channel.load(std::memory_order_relaxed)));
    return true;
}

AirStatus air_status()
{
    AirStatus a;
    a.started = s_started.load(std::memory_order_acquire);
    a.up = s_up.load(std::memory_order_acquire);
    a.channel = s_channel.load(std::memory_order_relaxed);
    a.peers = static_cast<uint8_t>(s_sched.peers());
    const air::SchedStats &st = s_sched.stats();
    a.tx = st.sent;
    a.tx_fail = st.failed;
    a.retries = st.retries;
    a.refused = st.refused + s_refused_down;
    a.rx = s_rx_ok.load(std::memory_order_relaxed);
    a.rx_bad = s_rx_bad.load(std::memory_order_relaxed);
    a.rx_lost = s_rx_lost.load(std::memory_order_relaxed);
    a.rate_fail = s_rate_fail.load(std::memory_order_relaxed) + st.rate_fail;
    a.guard = st.guard;
    a.lost = st.lost;
    return a;
}

std::expected<AirRateResult, Err> air_set_rate(AirRate rate, bool broadcast)
{
    if (!s_started.load(std::memory_order_acquire)) {
        return std::unexpected(Err::failed);
    }
    const air::RateChange r = s_sched.set_default_rate(broadcast, rate);
    ESP_LOGI(TAG, "espnow: %s rate %s (%u peers, %u refused)", broadcast ? "broadcast" : "unicast",
             rate == AirRate::fast ? "11g 6 Mbps" : "11b 1 Mbps", static_cast<unsigned>(r.peers),
             static_cast<unsigned>(r.failed));
    return AirRateResult{.peers = r.peers, .failed = r.failed};
}

AirRate air_rate(bool broadcast)
{
    return s_sched.default_rate(broadcast);
}

std::expected<AirChurn, Err> air_churn(uint32_t n)
{
    if (!s_started.load(std::memory_order_acquire)) {
        return std::unexpected(Err::failed);
    }
    static air::ChurnStats st;  // 2 KB: not on the core task's stack
    air::churn(s_radio, n, [] { return esp_timer_get_time(); }, st);
    return AirChurn{.n = st.n,
                    .failed = st.failed,
                    .add_p50_us = st.add.percentile(500),
                    .add_p99_us = st.add.percentile(990),
                    .add_max_us = st.add.max(),
                    .del_p50_us = st.del.percentile(500),
                    .del_p99_us = st.del.percentile(990),
                    .del_max_us = st.del.max()};
}

}  // namespace fr::net::esp
