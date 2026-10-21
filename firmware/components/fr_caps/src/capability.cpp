#include "fr/cap/capability.hpp"

namespace fr::cap {

void Capability::attach(uint8_t port, const char *name, Sink &sink)
{
    port_ = port;
    name_ = name;
    sink_ = &sink;
}

}  // namespace fr::cap
