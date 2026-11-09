#include "fr/posix/device.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <optional>
#include <string>

#include "catalog.hpp"  // generated fr::cap::catalog_hash
#include "fr/core/descriptor.hpp"
#include "fr/wire.hpp"

namespace fr::posix {

bool interface_mac(const std::string &ifname, std::array<uint8_t, 6> &out)
{
    const std::optional<std::string> text = read_file("/sys/class/net/" + ifname + "/address");
    if (!text) {
        return false;
    }
    unsigned b[6];
    if (std::sscanf(text->c_str(), "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) != 6) {
        return false;
    }
    for (size_t i = 0; i < 6; ++i) {
        out[i] = static_cast<uint8_t>(b[i]);
    }
    return true;
}

Device::Device(Core &core, IdentityFile &ident, NodeInfo info, std::span<PortEntry> ports)
    : core_(core), ident_(ident), info_(std::move(info)), ports_(ports)
{
    for (PortEntry &p : ports_) {
        if (p.port == 0) {
            p.cap = &node_cap_;
            p.ok = true;
        }
    }
    const core::DescriptorSource src{.fw_id_prefix = info_.fw_id_prefix,
                                     .catalog_hash = cap::catalog_hash(),
                                     .profile = info_.profile,
                                     .board = info_.board};
    desc_len_ = core::build_descriptor(src, ports_, desc_);
}

void Device::request_restart(uint8_t bye_reason, TimeUs delay_us)
{
    restart_bye_ = bye_reason;
    restart_at_ = core_.now() + delay_us;  // the RESULT (or the MSG's ACK) goes first, then the Runner's BYE
}

namespace {

/** The number after `"key":` in a flat JSON object, or nullopt. */
std::optional<long long> json_int(std::string_view j, std::string_view key)
{
    const std::string k = "\"" + std::string(key) + "\":";
    const size_t at = j.find(k);
    if (at == std::string_view::npos) {
        return std::nullopt;
    }
    const std::string rest(j.substr(at + k.size(), 24));
    char *end = nullptr;
    const long long v = std::strtoll(rest.c_str(), &end, 10);
    return end != rest.c_str() ? std::optional<long long>(v) : std::nullopt;
}

/** The string after `"key":"`, up to the next quote (aliases are RFC 1123 labels: no escapes), or nullopt. */
std::optional<std::string> json_str(std::string_view j, std::string_view key)
{
    const std::string k = "\"" + std::string(key) + "\":\"";
    const size_t at = j.find(k);
    if (at == std::string_view::npos) {
        return std::nullopt;
    }
    const size_t from = at + k.size();
    const size_t to = j.find('"', from);
    return to == std::string_view::npos ? std::nullopt : std::optional<std::string>(std::string(j.substr(from, to - from)));
}

}  // namespace

Status Device::dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, cap::Reply &reply)
{
    for (const PortEntry &p : ports_) {
        if (p.port == port && p.cap != nullptr) {
            return p.ok ? p.cap->dispatch(cmd, args, reply) : std::unexpected(Err::failed);
        }
    }
    return std::unexpected(Err::not_found);
}

void Device::report_all()
{
    for (const PortEntry &p : ports_) {
        if (p.cap != nullptr && p.ok && p.port != 0) {
            p.cap->report_all();
        }
    }
}

net::HelloInfo Device::hello_info()
{
    net::HelloInfo h;
    h.mac = info_.mac;
    h.chip = info_.chip;
    h.chip_rev = 0;
    h.fw_id_prefix = info_.fw_id_prefix;
    h.descriptor_hash = wire::descriptor_hash(descriptor());
    h.board_hash = wire::board_hash(info_.board);
    h.role = proto::Role::node;
    h.caps = net::kCapWifi | (ident_.addr != proto::kAddrUnassigned ? net::kCapProvisioned : 0);
#if FR_TEST_HOOKS
    h.caps |= net::kCapInjectEnabled;
#endif
    h.hb_interval_ms = info_.hb_ms;
    h.reset_reason = 1;  // ESP_RST_POWERON: a process start is a power-on to the hub
    h.ota_state = proto::OtaState::valid;
    return h;
}

net::Identity Device::identity()
{
    net::Identity id;
    id.addr = ident_.addr;
    id.net = ident_.net;
    std::memcpy(id.alias, ident_.alias.data(), std::min(ident_.alias.size(), net::Identity::kAliasMax));
    id.alias_rev = ident_.alias_rev;
    id.epoch = ident_.epoch;
    return id;
}

net::LinkInfo Device::link_info()
{
    net::LinkInfo li;
    if (wifi) {
        li = wifi();
    } else {
        li.wifi_up = true;
    }
    return net_ != nullptr ? core::hub_link_info(li, *net_) : li;
}

net::Vitals Device::vitals()
{
    net::Vitals v{};
    // MemAvailable stands in for the ESP32's free internal heap.
    if (const std::optional<std::string> mem = read_file("/proc/meminfo")) {
        const size_t at = mem->find("MemAvailable:");
        if (at != std::string::npos) {
            v.free_heap_kb = static_cast<uint32_t>(std::strtoul(mem->c_str() + at + 13, nullptr, 10));
        }
    }
    return v;
}

void Device::ota_frame(net::LinkKind, const wire::Header &h, std::span<const uint8_t> body, net::OtaReply &)
{
    say("ota: frame kind " + std::to_string(h.kind) + " (" + std::to_string(body.size()) +
        " B) ignored: this node updates with its image");
}

void Device::msg(uint16_t src, std::string_view topic, std::span<const uint8_t> data)
{
    if (topic == "fr.adopt") {
        // device_adopt: only the hub (src 0) provisions.
        const std::string_view j(reinterpret_cast<const char *>(data.data()), data.size());
        const auto addr = json_int(j, "addr");
        const auto net = json_int(j, "net");
        const auto rev = json_int(j, "alias_rev");
        const auto floor = json_int(j, "epoch_floor");
        const auto alias = json_str(j, "alias");
        if (src != 0 || !addr || !net || !alias || *addr <= 0 || *addr >= 0xF000 || *net < 0 || *net > 0xFFFF) {
            say("node: fr.adopt refused (src " + std::to_string(src) + ")");
            return;
        }
        ident_.addr = static_cast<uint16_t>(*addr);
        ident_.net = static_cast<uint16_t>(*net);
        ident_.alias = alias->substr(0, net::Identity::kAliasMax);
        ident_.alias_rev = rev ? static_cast<uint32_t>(*rev) : ident_.alias_rev;
        if (floor && *floor > 0) {
            // The next boot's epoch must pass the floor (begin_boot adds 1 to what is stored).
            const auto f = static_cast<uint16_t>(*floor - 1);
            if (static_cast<int16_t>(static_cast<uint16_t>(f - ident_.epoch)) > 0) {
                ident_.epoch = f;
            }
        }
        if (!ident_.save()) {
            say("node: fr.adopt could not save " + ident_.path());
            return;
        }
        say("node: adopted as " + ident_.alias + " (addr " + std::to_string(ident_.addr) + ", net " + std::to_string(ident_.net) +
            "); restarting with it");
        request_restart(net::kByeReboot, 500'000);
        return;
    }
    say("msg from " + std::to_string(src) + ": " + std::string(topic) + " (" + std::to_string(data.size()) + " B)");
}

// ---- NodeCap ----

Status NodeCap::identify(const cap::NodeIdentifyArgs &)
{
    if (n_.on_identify) {
        n_.on_identify();
    }
    return {};
}

std::expected<cap::NodeDescribeResult, Err> NodeCap::describe()
{
    if (n_.descriptor().empty()) {
        return std::unexpected(Err::failed);
    }
    return cap::NodeDescribeResult{.descriptor = n_.descriptor()};
}

Status NodeCap::reboot(const cap::NodeRebootArgs &args)
{
    n_.say(args.bootloader ? "node: reboot to maintenance asked; restarting" : "node: reboot asked; restarting");
    n_.request_restart(args.bootloader ? net::kByeMaintenance : net::kByeReboot);
    return {};
}

Status NodeCap::set_alias(const cap::NodeSetAliasArgs &args)
{
    IdentityFile &id = n_.ident();
    id.alias = std::string(args.alias).substr(0, net::Identity::kAliasMax);
    id.alias_rev = args.rev;
    if (!id.save()) {
        n_.say("node: set_alias " + id.alias + " not saved to " + id.path());
        return std::unexpected(Err::failed);
    }
    n_.say("node: alias " + id.alias + " (rev " + std::to_string(id.alias_rev) + ")");
    return {};
}

Status NodeCap::get_state()
{
    n_.report_all();
    return {};
}

Status NodeCap::bind_set(const cap::NodeBindSetArgs &args)
{
    return core::bind_set(n_.net(), args);
}

Status NodeCap::bind_clear(const cap::NodeBindClearArgs &args)
{
    return core::bind_clear(n_.net(), args);
}

std::expected<cap::NodeBindListResult, Err> NodeCap::bind_list()
{
    return core::bind_list(n_.net(), n_.bind_buf_);
}

}  // namespace fr::posix
