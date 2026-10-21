// One addressable endpoint of the node (spec 05 §5.5): a board instance (ports 1-239) or a system
// capability (node 0, diag 241). IDF-free: the descriptor builder and the host suite use it too.
#pragma once

#include <cstdint>

#include "fr/cap/capability.hpp"

namespace fr {

struct PortEntry {
    uint8_t port;
    const char *name;
    cap::Capability *cap;
    bool ok;  // false: init failed; CMDs answer FAILED
};

}  // namespace fr
