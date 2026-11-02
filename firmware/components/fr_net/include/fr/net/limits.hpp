// Table and queue sizes a profile's memory class sets (fr_net's Kconfig, spec 05 §5.17): on target the sdkconfig
// value (`memory: small` lowers them in sdkconfig.board), on the host the Kconfig default, so the host suite and every
// other profile keep today's sizes. IDF-free: the host suite includes it through net.hpp and air_sched.hpp.
#pragma once

#include <cstddef>

#if defined(ESP_PLATFORM)
#include "sdkconfig.h"
#define FR_NET_LIMIT(sym, host_default) (sym)
#else
#define FR_NET_LIMIT(sym, host_default) (host_default)
#endif

namespace fr::net::limits {

inline constexpr size_t kWindowSources = FR_NET_LIMIT(CONFIG_FR_WINDOW_SOURCES_NODE, 64);
inline constexpr size_t kDirectory = FR_NET_LIMIT(CONFIG_FR_DIRECTORY_MAX, 64);
inline constexpr size_t kNeighbors = FR_NET_LIMIT(CONFIG_FR_NET_NEIGHBORS_MAX, 20);
inline constexpr size_t kOutbox = FR_NET_LIMIT(CONFIG_FR_NET_OUTBOX, 8);
inline constexpr size_t kRespCache = FR_NET_LIMIT(CONFIG_FR_NET_RESP_CACHE, 8);
inline constexpr size_t kExecSlots = FR_NET_LIMIT(CONFIG_FR_NET_EXEC_SLOTS, 8);
inline constexpr size_t kRelayQueue = FR_NET_LIMIT(CONFIG_FR_NET_RELAY_QUEUE, 8);
inline constexpr size_t kNodeOut = FR_NET_LIMIT(CONFIG_FR_NET_NODE_OUT, 8);
inline constexpr size_t kBenchSources = FR_NET_LIMIT(CONFIG_FR_NET_BENCH_SOURCES, 4);
inline constexpr size_t kTcpTxBytes = FR_NET_LIMIT(CONFIG_FR_NET_TCP_TX_BYTES, 8192);
inline constexpr size_t kAirQueue = FR_NET_LIMIT(CONFIG_FR_NET_AIR_QUEUE, 16);
inline constexpr size_t kAirRxSlots = FR_NET_LIMIT(CONFIG_FR_NET_AIR_RX_SLOTS, 16);

}  // namespace fr::net::limits

#undef FR_NET_LIMIT
