// Host shim (firmware/test/host/shim/wifi_sim.hpp): lwIP's ip_addr_t as IDF v6.1 builds it (LWIP_IPV4 and LWIP_IPV6:
// a union with a type), and the macros wifi_csi and ping_sock.h use (lwip/src/include/lwip/ip_addr.h, opt.h).
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ip4_addr {
    uint32_t addr;
} ip4_addr_t;

typedef struct ip6_addr {
    uint32_t addr[4];
    uint8_t zone;
} ip6_addr_t;

enum lwip_ip_addr_type {
    IPADDR_TYPE_V4 = 0U,
    IPADDR_TYPE_V6 = 6U,
    IPADDR_TYPE_ANY = 46U,
};

typedef struct ip_addr {
    union {
        ip6_addr_t ip6;
        ip4_addr_t ip4;
    } u_addr;
    uint8_t type;
} ip_addr_t;

extern const ip_addr_t ip_addr_any_type;

#define IP_ANY_TYPE (&ip_addr_any_type)
#define IP_DEFAULT_TTL 255
#define ip_2_ip4(ipaddr) (&((ipaddr)->u_addr.ip4))
#define IP_SET_TYPE_VAL(ipaddr, iptype) do { (ipaddr).type = (iptype); } while (0)
#define ip4_addr_copy(dest, src) ((dest).addr = (src).addr)
#define ip_addr_copy_from_ip4(dest, src) do { \
    ip4_addr_copy(*ip_2_ip4(&(dest)), src);  \
    IP_SET_TYPE_VAL(dest, IPADDR_TYPE_V4);   \
} while (0)

#ifdef __cplusplus
}
#endif
