// The AP model (design m2-c2 D7): see ap.hpp.
#include "sim/ap.hpp"

#include <algorithm>
#include <cmath>

#include "sim/rng.hpp"

namespace frsim {

namespace {

// rng.hpp's purposes stop below 40; the AP's draws key on these.
constexpr uint8_t kRssi = 40;
constexpr uint8_t kUplink = 41;
constexpr uint8_t kDownlink = 42;
constexpr uint8_t kAssoc = 43;
constexpr uint8_t kUdpLoss = 44;

}  // namespace

Ap::Ap(Medium *medium, const ApConfig &cfg) : medium_(medium), cfg_(cfg) {}

void Ap::set_up(bool up)
{
    if (up == up_) {
        return;
    }
    up_ = up;
    for (const Listener &fn : listeners_) {
        fn(up);
    }
}

double Ap::draw(const fr::net::Mac &mac, uint64_t n, uint8_t purpose) const
{
    return rng::uniform(cfg_.seed, mac, n, kBssid, static_cast<rng::Purpose>(purpose));
}

int8_t Ap::rssi(const fr::net::Mac &mac) const
{
    const double lo = cfg_.rssi_min_dbm;
    const double hi = cfg_.rssi_max_dbm;
    return static_cast<int8_t>(std::lround(lo + (hi - lo) * draw(mac, 0, kRssi)));
}

bool Ap::associated(const fr::net::Mac &mac, uint8_t channel) const
{
    return up_ && channel == cfg_.channel && rssi(mac) > kAssocMinRssi;
}

fr::net::LinkInfo Ap::link_info(const fr::net::Mac &mac, uint8_t channel) const
{
    if (!associated(mac, channel)) {
        return {};
    }
    return {.wifi_up = true, .channel = cfg_.channel, .bssid = kBssid, .rssi = rssi(mac)};
}

fr::TimeUs Ap::uplink_us(const fr::net::Mac &mac, uint64_t n) const
{
    const double ms = cfg_.uplink_min_ms + (cfg_.uplink_max_ms - cfg_.uplink_min_ms) * draw(mac, n, kUplink);
    return static_cast<fr::TimeUs>(ms * 1000);
}

fr::TimeUs Ap::downlink_us(const fr::net::Mac &mac, uint64_t n) const
{
    const double ms = cfg_.downlink_min_ms + (cfg_.downlink_max_ms - cfg_.downlink_min_ms) * draw(mac, n, kDownlink);
    return static_cast<fr::TimeUs>(ms * 1000);
}

fr::TimeUs Ap::assoc_us(const fr::net::Mac &mac, uint64_t n) const
{
    const double ms = cfg_.assoc_min_ms + (cfg_.assoc_max_ms - cfg_.assoc_min_ms) * draw(mac, n, kAssoc);
    return static_cast<fr::TimeUs>(ms * 1000);
}

bool Ap::udp_lost(const fr::net::Mac &mac, uint64_t n, fr::TimeUs at) const
{
    return after_gap(at) != at || (cfg_.udp_loss > 0 && draw(mac, n, kUdpLoss) < cfg_.udp_loss);
}

fr::TimeUs Ap::after_gap(fr::TimeUs t) const
{
    if (!cfg_.gaps || cfg_.gaps->every_s <= 0 || cfg_.gaps->len_ms == 0) {
        return t;
    }
    // A gap of len_ms at the start of every period of every_s, on the executor's clock.
    const auto period = static_cast<fr::TimeUs>(cfg_.gaps->every_s * 1'000'000);
    const fr::TimeUs len = std::min<fr::TimeUs>(static_cast<fr::TimeUs>(cfg_.gaps->len_ms) * 1000, period);
    const fr::TimeUs into = ((t % period) + period) % period;
    return into < len ? t - into + len : t;
}

fr::TimeUs Ap::account(size_t bytes)
{
    if (medium_ != nullptr) {
        medium_->account_ip(cfg_.channel, bytes, static_cast<uint32_t>(cfg_.phy_rate_mbps));
    }
    return static_cast<fr::TimeUs>(static_cast<double>(bytes) * 8.0 / cfg_.phy_rate_mbps);
}

}  // namespace frsim
