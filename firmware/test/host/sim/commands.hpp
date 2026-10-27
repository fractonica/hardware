// fr_net_node's stdin command table, shared with the fleet's control channel (design m2-c2 D2, D8): Commands::run
// takes one line for one node and answers with the lines fr_net_node always printed, through the node's Out.
// The state printers (`state`, `neighbors`, `directory`) live here too. What only one host has stays with it:
// fr_net_node keeps `line`, `lines`, `crash` and `quit` and the serial lines it reads on stdin; the fleet adds
// `diag <line>`, `power off|on` and `usb attach|detach` (tools/fleet.cpp). Test code: it may allocate.
#pragma once

#include <string>
#include <string_view>

#include "sim/node.hpp"

namespace frsim {

class Commands
{
public:
    struct Result {
        bool known = false;  // a command of the table (fr_net_node ignores any other line)
        bool ok = true;      // it parsed and did what it says (a refused bind, inject or msg is false)
    };

    /**
     * One line of the table: `state`, `udp_block <s>`, `drop_hub_link <s>`, `ip_block <s>`, `tcp 0|1`, `usb 0|1`,
     * `hub_mute 0|1`, `wifi_down <s>`, `loss <pct> <s> [both|tx|rx]`, `air_loss <pct>`, `msg <dst|broadcast> <topic>
     * [data…]`, `msg_reliable <dst> <topic> [data…]`, `bind <hex>`, `unbind <slot|all>`, `bindings`, `neighbors`,
     * `directory`, `inject <gesture>`, `bye`, and (M2-C2, D20) `log <E|W|I|D|V> <tag> <text…>` and `log_rate <lines/s>`
     * (the log source's generator, scaled by `pace`).
     */
    static Result run(NodeCtx &ctx, std::string_view line, double pace = 1);
};

/** `state`: Net's view, the C5 and C6 parts, and (M2-C1) fr_ota's health bits and the hub session. */
void print_state(Out &out, const fr::net::Net &net, const AirCounters *air, uint32_t health);
/** `neighbors`: the neighbour table. */
void print_neighbors(Out &out, const fr::net::Net &net, fr::TimeUs now);
/** `directory`: the directory as NET/DIRECTORY (or a RESOLVE answer) left it, by addr. */
void print_directory(Out &out, const fr::net::Net &net);

}  // namespace frsim
