// A POSIX node's answer to Net (fr_core's role on target, design uno-q-host §2.5 step 2): dispatch by port, the
// HELLO facts, the identity from the IdentityFile, and fr.node on port 0 (describe, get_state, set_alias, reboot,
// bindings). There is no OTA here: a Linux node's software comes with its image, so OTA frames are logged and left
// unanswered (the hub refuses OTA for such devices). fr.node.reboot asks the Runner to stop with kExitRestart, and
// the service manager starts the process again (a new boot, a new epoch). A MSG `fr.adopt` from the hub (device_adopt,
// UNOQ-1 step 5) carries the identity a flash would write: it is saved, then the node restarts with it.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <span>
#include <string>

#include "fr/core/core.hpp"
#include "fr/core/node_net.hpp"
#include "fr/core/port.hpp"
#include "fr/net/net.hpp"
#include "fr/posix/store.hpp"
#include "node.hpp"      // generated fr::cap::Node
#include "protocol.hpp"  // generated fr::proto constants

namespace fr::posix {

/** What a node is, beyond its identity: the HELLO and descriptor facts. */
struct NodeInfo {
    std::array<uint8_t, 6> mac{};
    /** HELLO's image chip id; kChipLinux for a POSIX node (the registry then shows no ESP32 chip). */
    uint8_t chip = 0xFF;
    std::array<uint8_t, 8> fw_id_prefix{};
    std::string board;
    std::string profile;
    uint32_t hb_ms = 1000;
};

inline constexpr uint8_t kChipLinux = 0xFF;
/** The exit code fr.node.reboot asks for: the service manager restarts the node. */
inline constexpr int kExitRestart = 75;

class Device;

/** fr.node on port 0. */
class NodeCap final : public cap::Node
{
public:
    explicit NodeCap(posix::Device &n) : n_(n) {}

    Status identify(const cap::NodeIdentifyArgs &) override;
    std::expected<cap::NodeDescribeResult, Err> describe() override;
    Status reboot(const cap::NodeRebootArgs &args) override;
    Status set_alias(const cap::NodeSetAliasArgs &args) override;
    Status set_groups(const cap::NodeSetGroupsArgs &) override { return std::unexpected(Err::unsupported); }
    Status net_set(const cap::NodeNetSetArgs &) override { return std::unexpected(Err::unsupported); }
    Status get_state() override;
    Status bind_set(const cap::NodeBindSetArgs &args) override;
    Status bind_clear(const cap::NodeBindClearArgs &args) override;
    std::expected<cap::NodeBindListResult, Err> bind_list() override;

private:
    posix::Device &n_;
};

class Device final : public net::Host
{
public:
    /** `ports` holds port 0 (its cap is set to this node's fr.node here) and the board's instances. */
    Device(Core &core, IdentityFile &ident, NodeInfo info, std::span<PortEntry> ports);

    void set_net(net::Net &net) { net_ = &net; }
    net::Net &net() { return *net_; }
    NodeCap &node_cap() { return node_cap_; }
    std::span<const uint8_t> descriptor() const { return {desc_, desc_len_}; }
    IdentityFile &ident() { return ident_; }

    /** A line for the log. */
    std::function<void(const std::string &)> log;
    /** The Wi-Fi association for HELLO and HEARTBEAT (default: up, no details). */
    std::function<net::LinkInfo()> wifi;
    /** fr.node.identify: something the person can see on the board (default: nothing). */
    std::function<void()> on_identify;

    /** A restart was asked (fr.node.reboot, fr.adopt): due now. The Runner sends the BYE and stops with kExitRestart. */
    bool restart_requested() const { return restart_at_ != 0 && core_.now() >= restart_at_; }
    uint8_t restart_bye() const { return restart_bye_; }
    /** Restart in `delay_us`, so the answer to what asked for it (a RESULT, a MSG's ACK) leaves first. */
    void request_restart(uint8_t bye_reason, TimeUs delay_us = 200'000);

    // net::Host
    Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, cap::Reply &reply) override;
    void report_all() override;
    net::HelloInfo hello_info() override;
    net::Identity identity() override;
    net::LinkInfo link_info() override;
    net::Vitals vitals() override;
    void ota_frame(net::LinkKind from, const wire::Header &h, std::span<const uint8_t> body,
                   net::OtaReply &reply) override;
    void msg(uint16_t src, std::string_view topic, std::span<const uint8_t> data) override;

private:
    friend class NodeCap;

    void say(const std::string &line) const
    {
        if (log) {
            log(line);
        }
    }

    Core &core_;
    IdentityFile &ident_;
    NodeInfo info_;
    std::span<PortEntry> ports_;
    NodeCap node_cap_{*this};
    net::Net *net_ = nullptr;
    uint8_t desc_[proto::Descriptor::kMaxSize];
    size_t desc_len_ = 0;
    uint8_t bind_buf_[core::kBindListMax];
    TimeUs restart_at_ = 0;
    uint8_t restart_bye_ = net::kByeReboot;
};

/** The MAC of a network interface (`/sys/class/net/<if>/address`): false when it cannot be read. */
bool interface_mac(const std::string &ifname, std::array<uint8_t, 6> &out);

}  // namespace fr::posix
