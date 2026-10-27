// Spike S2's test hooks on target (design m2-c4-gateway D19): diag `air ...`, `wifi proto`, `cpu` and `net stream`
// through fr_diag's TestHooks. The bench and the stream are Net's (IDF-free, the kit runs the same); the radio hooks are
// fr_net's ESP side (espnow.cpp, hub_link.cpp). `cpu` compares the idle tasks' run-time counters (FreeRTOS run-time
// stats on the esp_timer clock, 64-bit: debug builds enable both in firmware/config/sdkconfig.build.debug) against a
// sample about 10 s old, taken every second by an esp_timer that starts at the first `cpu`; that first answer covers
// the time since boot. Core task, except the sampler's callback (esp_timer task), which only fills the ring.
#include "s2_hooks.hpp"

#include <algorithm>
#include <cstring>

#include "esp_timer.h"
#include "fr/net/esp.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"
#include "sdkconfig.h"

namespace fr::core {
namespace {

#if CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS
constexpr size_t kCores = CONFIG_FREERTOS_NUMBER_OF_CORES;
static_assert(kCores <= diag::kCpuCoresMax);
constexpr size_t kSamples = 12;  // one a second: 10 s back, and some slack
constexpr uint64_t kSampleUs = 1'000'000;
constexpr TimeUs kWindowUs = 10'000'000;

struct Sample {
    TimeUs at = 0;
    uint64_t idle[kCores] = {};
};

/** Now's sample (any task). */
Sample take_sample()
{
    Sample s;
    s.at = esp_timer_get_time();
    for (size_t i = 0; i < kCores; ++i) {
        s.idle[i] = ulTaskGetIdleRunTimeCounterForCore(static_cast<BaseType_t>(i));
    }
    return s;
}

portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
Sample s_ring[kSamples];
size_t s_ring_n = 0;  // samples taken so far (the ring holds the last kSamples)
esp_timer_handle_t s_sampler = nullptr;

void on_sample(void *)
{
    const Sample s = take_sample();
    portENTER_CRITICAL(&s_mux);
    s_ring[s_ring_n % kSamples] = s;
    ++s_ring_n;
    portEXIT_CRITICAL(&s_mux);
}

std::expected<diag::CpuStatus, Err> cpu_share()
{
    if (s_sampler == nullptr) {
        const esp_timer_create_args_t args = {
            .callback = on_sample,
            .arg = nullptr,
            .dispatch_method = ESP_TIMER_TASK,
            .name = "fr_cpu",
            .skip_unhandled_events = true,
        };
        if (esp_timer_create(&args, &s_sampler) != ESP_OK || esp_timer_start_periodic(s_sampler, kSampleUs) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
    }
    const Sample now = take_sample();
    // The oldest sample at most 10 s back (none yet: boot, when every counter was 0).
    Sample base{};
    portENTER_CRITICAL(&s_mux);
    const size_t n = std::min(s_ring_n, kSamples);
    for (size_t k = 0; k < n; ++k) {
        const Sample &c = s_ring[(s_ring_n - n + k) % kSamples];
        if (now.at - c.at <= kWindowUs + static_cast<TimeUs>(kSampleUs / 2)) {
            base = c;
            break;
        }
    }
    portEXIT_CRITICAL(&s_mux);
    diag::CpuStatus out;
    const TimeUs span = std::max<TimeUs>(now.at - base.at, 1);
    out.window_ms = static_cast<uint32_t>(span / 1000);
    out.cores = static_cast<uint8_t>(kCores);
    for (size_t i = 0; i < kCores; ++i) {
        const uint64_t idle = now.idle[i] - base.idle[i];
        out.idle_permille[i] = static_cast<uint16_t>(std::min<uint64_t>(1000, idle * 1000 / static_cast<uint64_t>(span)));
    }
    return out;
}
#else
std::expected<diag::CpuStatus, Err> cpu_share()
{
    return std::unexpected(Err::unsupported);  // a build without FreeRTOS run-time stats
}
#endif

class S2Hooks final : public diag::TestHooks
{
public:
    void bind(net::Net &net) { net_ = &net; }

    Status bench_tx(const uint8_t *dst, uint32_t count, uint16_t len, uint32_t interval_ms, bool echo) override
    {
        net::Mac mac = net::kBroadcastMac;
        if (dst != nullptr) {
            std::memcpy(mac.data(), dst, mac.size());
        }
        return net_->bench_tx(mac, count, len, interval_ms, echo);
    }

    diag::BenchStatus bench() const override
    {
        const net::BenchReport r = net_->bench_report();
        diag::BenchStatus b;
        const net::BenchTx &t = r.tx;
        b.tx = {.running = t.running,
                .broadcast = t.broadcast,
                .dst = {},
                .echo = t.echo,
                .count = t.count,
                .len = t.len,
                .interval_ms = t.interval_ms,
                .sent = t.sent,
                .refused = t.refused,
                .acked = t.acked,
                .failed = t.failed,
                .echoes = t.echoes,
                .rtt_p50_us = t.rtt_p50_us,
                .rtt_p99_us = t.rtt_p99_us,
                .rtt_max_us = t.rtt_max_us,
                .elapsed_ms = t.elapsed_ms};
        std::memcpy(b.tx.dst, t.dst.data(), sizeof(b.tx.dst));
        static_assert(diag::kBenchSources == net::kBenchSources);
        b.rx_count = r.rx_count;
        for (size_t i = 0; i < r.rx_count; ++i) {
            const net::BenchRx &x = r.rx[i];
            diag::BenchRxStatus &o = b.rx[i];
            std::memcpy(o.mac, x.mac.data(), sizeof(o.mac));
            o.addr = x.addr;
            o.received = x.received;
            o.gaps = x.gaps;
            o.dups = x.dups;
            o.echoed = x.echoed;
            o.rssi_p50 = x.rssi_p50;
            o.age_ms = x.age_ms;
        }
        return b;
    }

    void bench_reset() override { net_->bench_reset(); }

    std::expected<diag::RateStatus, Err> air_rate(bool fast, bool broadcast) override
    {
        auto r = net::esp::air_set_rate(fast ? net::AirRate::fast : net::AirRate::robust, broadcast);
        if (!r) {
            return std::unexpected(r.error());
        }
        return diag::RateStatus{.peers = r->peers, .failed = r->failed};
    }

    std::expected<diag::TxPowerStatus, Err> air_txpower(std::optional<int8_t> qdbm) override
    {
        auto r = net::esp::set_tx_power(qdbm);
        if (!r) {
            return std::unexpected(r.error());
        }
        return diag::TxPowerStatus{.qdbm = r->qdbm, .profile_qdbm = r->profile_qdbm};
    }

    std::expected<diag::ChurnStatus, Err> air_churn(uint32_t n) override
    {
        auto c = net::esp::air_churn(n);
        if (!c) {
            return std::unexpected(c.error());
        }
        return diag::ChurnStatus{.n = c->n,
                                 .failed = c->failed,
                                 .add_p50_us = c->add_p50_us,
                                 .add_p99_us = c->add_p99_us,
                                 .add_max_us = c->add_max_us,
                                 .del_p50_us = c->del_p50_us,
                                 .del_p99_us = c->del_p99_us,
                                 .del_max_us = c->del_max_us};
    }

    Status wifi_proto(bool ax) override { return net::esp::wifi_proto(ax); }

    std::expected<diag::CpuStatus, Err> cpu() override { return cpu_share(); }

    Status net_stream(uint32_t hz, uint32_t seconds, uint16_t len) override { return net_->stream(hz, seconds, len); }

private:
    net::Net *net_ = nullptr;
};

S2Hooks s_hooks;

}  // namespace

diag::TestHooks &s2_hooks(net::Net &net)
{
    s_hooks.bind(net);
    return s_hooks;
}

}  // namespace fr::core
