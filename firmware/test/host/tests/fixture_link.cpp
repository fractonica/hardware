// fr::core::link_info() for the host suite (fixture_link.hpp).
#include "tests/fixture_link.hpp"

#include "fr/core/node_net.hpp"

namespace frt {

FixtureLink &fixture_link()
{
    static FixtureLink link;
    return link;
}

}  // namespace frt

namespace fr::core {

net::LinkInfo link_info()
{
    const frt::FixtureLink &l = frt::fixture_link();
    if (l.net != nullptr) {
        return hub_link_info({}, *l.net);
    }
    net::LinkInfo li;
    li.hub_session = l.session;
    li.hub_heard_at = l.hub_live && l.core != nullptr ? l.core->now() : l.heard_at;
    li.hub_epoch = l.epoch;
    return li;
}

}  // namespace fr::core
