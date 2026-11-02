// L2 transmitter service (spec 07 §7.7-7.8; design csi-c1 D9): fr.radio_tx over any hal::RadioTx. Host-buildable.
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/radio_tx.hpp"
#include "radio_tx.hpp"  // generated fr::cap::RadioTx

namespace fr {

/**
 * start checks peer_mac (6 bytes, not a group address: INVALID_ARGS) and hands it to the driver
 * (hal::RadioTx::start; BUSY without a channel), reports `sending` true and arms a core timer for `seconds` (0: none),
 * which also notices a driver that stopped itself; stop and the deadline stop the driver and report `sending` false.
 */
class RadioTxService final : public cap::RadioTx
{
public:
    /** fr.radio_tx has no config: the generated fr_board constructs it from the driver alone. */
    explicit RadioTxService(hal::RadioTx &tx);

    Status init(Core &core);
    hal::Selftest selftest();

    /** The core timer's look at the driver (a run it ended itself) while sending. */
    static constexpr uint32_t kPollUs = 250'000;

    Status start(const cap::RadioTxStartArgs &args) override;
    Status stop() override;
    bool sending() const override { return sending_; }

private:
    void on_timer();
    void end();

    hal::RadioTx &tx_;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    bool sending_ = false;
    TimeUs deadline_ = 0;  // 0: until stop
};

}  // namespace fr
