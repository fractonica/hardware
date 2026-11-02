// fr.radio_tx (design csi-c1 D9): the arguments checked, the driver started and stopped, `sending` kept, a run's
// `seconds` and a driver that stopped itself (the station lost its channel) noticed by one core timer.
#include "fr/services/radio_tx_service.hpp"

#include <algorithm>

namespace fr {

RadioTxService::RadioTxService(hal::RadioTx &tx) : tx_(tx) {}

Status RadioTxService::init(Core &core)
{
    core_ = &core;
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    return tx_.init(core);
}

hal::Selftest RadioTxService::selftest()
{
    return tx_.selftest();
}

Status RadioTxService::start(const cap::RadioTxStartArgs &args)
{
    std::array<uint8_t, 6> peer{};
    if (args.peer_mac.size() != peer.size() || (args.peer_mac[0] & 0x01) != 0) {
        return std::unexpected(Err::invalid_args);  // not a station MAC: 6 bytes, the group bit clear
    }
    std::copy(args.peer_mac.begin(), args.peer_mac.end(), peer.begin());
    if (core_ == nullptr || timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (auto st = tx_.start(peer, args.rate_hz, args.len); !st) {
        if (sending_) {
            end();  // the run it replaced is gone too
        }
        return st;
    }
    deadline_ = args.seconds > 0 ? core_->now() + static_cast<TimeUs>(args.seconds) * 1'000'000 : 0;
    if (!sending_) {
        sending_ = true;
        report_sending(true);
    }
    on_timer();  // arms the next look
    return {};
}

Status RadioTxService::stop()
{
    static_cast<void>(tx_.stop());
    if (sending_) {
        end();
    }
    return {};
}

void RadioTxService::end()
{
    sending_ = false;
    timer_->stop();
    report_sending(false);
}

void RadioTxService::on_timer()
{
    if (!sending_) {
        return;
    }
    const TimeUs now = core_->now();
    if (!tx_.running() || (deadline_ != 0 && now >= deadline_)) {
        static_cast<void>(tx_.stop());
        end();
        return;
    }
    const TimeUs left = deadline_ != 0 ? deadline_ - now : kPollUs;
    timer_->start(static_cast<uint32_t>(std::min<TimeUs>(left, kPollUs)));
}

}  // namespace fr
