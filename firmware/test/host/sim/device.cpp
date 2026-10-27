// Device and NodeCap (design m2-c2 D2): what Net asks of a node, as fr_core answers it on target, moved out of
// tools/net_node.cpp unchanged but for its seams: the spec (NodeSpec) instead of the options, the node's Out
// instead of stdout, and NodeLinks for the Wi-Fi part of link_info().
#include <algorithm>
#include <cstring>

#include "catalog.hpp"
#include "fr/core/descriptor.hpp"
#include "sim/node.hpp"
#include "tools/ota_fake.hpp"

namespace frsim {

using fr::net::LinkKind;

int board_test_pin(std::string_view board)
{
    if (board == "esp32c3-oled042") {
        return 10;
    }
    if (board == "waveshare-esp32s3-lcd19") {
        return 16;
    }
    if (board == "esp32s3-devkitc1-n16r8") {
        return -1;
    }
    return 20;  // esp32c6-supermini, and any other board (as before M2-C1)
}

Device::Device(fr::Core &core, const NodeSpec &spec, std::span<fr::PortEntry> ports, Out &out)
    : core_(core), spec_(spec), ports_(ports), out_(out)
{
    store_alias(spec.alias, spec.alias_rev);
    const fr::core::DescriptorSource src{.fw_id_prefix = spec.fw,
                                         .catalog_hash = fr::cap::catalog_hash(),
                                         .profile = spec_.profile.c_str(),
                                         .board = spec_.board.c_str()};
    desc_len_ = fr::core::build_descriptor(src, ports, desc_);
}

void Device::reboot(bool bootloader)
{
    net_->bye(bootloader ? fr::net::kByeMaintenance : fr::net::kByeReboot);
    reboot_at_ = core_.now() + 200'000;
}

void Device::reboot_into_ota()
{
    net_->bye(fr::net::kByeOta);
    reboot_at_ = core_.now() + 200'000;
    reboot_reason_ = "ota";
}

void Device::store_alias(std::string_view a, uint32_t rev)
{
    alias_.assign(a.substr(0, fr::net::Identity::kAliasMax));
    alias_rev_ = rev;
}

void Device::report_board()
{
    for (const fr::PortEntry &p : ports_) {
        if (p.cap != nullptr && p.ok && p.port != 0) {
            p.cap->report_all();
        }
    }
}

fr::Status Device::dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, fr::cap::Reply &reply)
{
    if (out_.frames()) {
        out_.emit(R"({"ev":"dispatch","port":%u,"cmd":%u,"capacity":%zu})", unsigned{port}, unsigned{cmd}, reply.capacity());
    }
    for (const fr::PortEntry &p : ports_) {
        if (p.port == port && p.cap != nullptr) {
            return p.ok ? p.cap->dispatch(cmd, args, reply) : std::unexpected(fr::Err::failed);
        }
    }
    return std::unexpected(fr::Err::not_found);
}

fr::net::HelloInfo Device::hello_info()
{
    fr::net::HelloInfo h;
    h.mac = spec_.mac;
    h.chip = spec_.chip;
    h.chip_rev = 1;
    h.fw_id_prefix = spec_.fw;
    h.descriptor_hash = fr::wire::descriptor_hash(descriptor());
    h.board_hash = fr::wire::board_hash(spec_.board);
    h.role = spec_.role;
    // Serial only (a radio-off build, design m2-c1-hil D6): no `wifi`.
    h.caps = (spec_.ip ? fr::net::kCapWifi : 0) | fr::net::kCapInjectEnabled |
             (spec_.addr != fr::proto::kAddrUnassigned ? fr::net::kCapProvisioned : 0) | (air_ ? fr::net::kCapEspnowV2 : 0);
    h.hb_interval_ms = spec_.hb_ms;
    h.reset_reason = 1;
    // As fr_core: PENDING_VERIFY until the health gate marks the image valid.
    h.ota_state = flash_ != nullptr && flash_->state().pending ? fr::proto::OtaState::pending_verify
                                                              : fr::proto::OtaState::valid;
    return h;
}

fr::net::Identity Device::identity()
{
    fr::net::Identity id;
    id.addr = spec_.addr;
    id.net = spec_.net;
    std::memcpy(id.alias, alias_.data(), std::min(alias_.size(), fr::net::Identity::kAliasMax));
    id.alias_rev = alias_rev_;
    id.epoch = spec_.epoch;
    return id;
}

fr::net::LinkInfo Device::link_info()
{
    const fr::net::LinkInfo li = links_ != nullptr ? links_->wifi() : fr::net::LinkInfo{};
    // The hub fields as fr_core fills them (design m2-c1-hil D11): FixtureService's release rule reads them.
    return net_ != nullptr ? fr::core::hub_link_info(li, *net_) : li;
}

fr::net::Vitals Device::vitals()
{
    return {.free_heap_kb = 200, .vbat_mv = 0, .ota_busy = ota_ != nullptr && ota_->busy(), .low_batt = false};
}

void Device::ota_frame(LinkKind from, const fr::wire::Header &h, std::span<const uint8_t> body, fr::net::OtaReply &reply)
{
    if (out_.frames()) {
        out_.emit(R"({"ev":"ota_frame","link":"%s","kind":%u,"seq":%u,"ack_req":%s,"len":%zu})",
                  from == LinkKind::tcp ? "tcp" : from == LinkKind::serial ? "serial" : "udp", unsigned{h.kind},
                  static_cast<unsigned>(h.seq), (h.flags & fr::wire::kFlagAckReq) != 0 ? "true" : "false", body.size());
    }
    if (ota_ != nullptr) {
        ota_->on_frame(h.kind, body, reply);  // as fr_core's NetHost
    }
}

void Device::msg(uint16_t src, std::string_view topic, std::span<const uint8_t> data)
{
    const std::string_view text(reinterpret_cast<const char *>(data.data()), data.size());
    if (fr::wire::utf8_valid(data)) {
        out_.emit(R"({"ev":"msg","src":%u,"topic":"%s","data":"%s","len":%zu})", unsigned{src}, json_text(topic).c_str(),
                  json_text(text).c_str(), data.size());
    } else {
        out_.emit(R"({"ev":"msg","src":%u,"topic":"%s","data_hex":"%s","len":%zu})", unsigned{src},
                  json_text(topic).c_str(), hex(data).c_str(), data.size());
    }
}

// ---- NodeCap ----

std::expected<fr::cap::NodeDescribeResult, fr::Err> NodeCap::describe()
{
    if (d_.descriptor().empty()) {
        return std::unexpected(fr::Err::failed);
    }
    return fr::cap::NodeDescribeResult{.descriptor = d_.descriptor()};
}

fr::Status NodeCap::reboot(const fr::cap::NodeRebootArgs &args)
{
    d_.reboot(args.bootloader);
    return {};
}

fr::Status NodeCap::set_alias(const fr::cap::NodeSetAliasArgs &args)
{
    d_.store_alias(args.alias, args.rev);
    d_.out().emit(R"({"ev":"set_alias","alias":"%s","rev":%u})", d_.alias().c_str(), d_.alias_rev());
    return {};
}

fr::Status NodeCap::get_state()
{
    d_.report_board();
    return {};
}

fr::Status NodeCap::bind_set(const fr::cap::NodeBindSetArgs &args)
{
    const fr::Status st = fr::core::bind_set(d_.net(), args);
    d_.out().emit(R"({"ev":"bind_set","slot":%u,"on_port":%u,"on_cls":%u,"to_addr":%u,"to_port":%u,"to_cls":%u,"ok":%s})",
                  unsigned{args.slot}, unsigned{args.on_port}, unsigned{args.on_cls}, unsigned{args.to_addr},
                  unsigned{args.to_port}, unsigned{args.to_cls}, st ? "true" : "false");
    return st;
}

fr::Status NodeCap::bind_clear(const fr::cap::NodeBindClearArgs &args)
{
    const fr::Status st = fr::core::bind_clear(d_.net(), args);
    d_.out().emit(R"({"ev":"bind_clear","slot":%u,"ok":%s})", unsigned{args.slot}, st ? "true" : "false");
    return st;
}

std::expected<fr::cap::NodeBindListResult, fr::Err> NodeCap::bind_list()
{
    return fr::core::bind_list(d_.net(), d_.bind_buf());
}

}  // namespace frsim
