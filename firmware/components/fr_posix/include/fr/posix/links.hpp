// The hub links of a POSIX node (spec 05 §5.12.1-2, design uno-q-host §2.5 step 2): TCP `len u16 LE | envelope`,
// node-initiated, and one UDP datagram per envelope to the same host and port. The hub's name is resolved with
// getaddrinfo (on the UNO Q systemd-resolved answers `<mac>.local` names over mDNS), at every connect attempt, so a
// hub that moved is found again. Connects are non-blocking with hub_link.cpp's timing: a 3 s connect timeout, a
// backoff from 0.25 s doubling to 5 s, back to 0.25 s after a connection that lasted 10 s. Sends never block the core:
// what the socket does not take waits in an 8 KB buffer (hub_link.cpp's TX ring) and goes when it is writable; a frame
// that does not fit is dropped (busy), as on target.
#pragma once

#include <netinet/in.h>

#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <vector>

#include "fr/net/link.hpp"
#include "fr/net/net.hpp"
#include "fr/posix/core.hpp"

namespace fr::posix {

class UdpLink;

class TcpLink final : public net::Link
{
public:
    struct Timing {
        TimeUs backoff_min_us = 250'000;
        TimeUs backoff_max_us = 5'000'000;
        TimeUs stable_us = 10'000'000;
        TimeUs connect_timeout_us = 3'000'000;
    };
    static constexpr size_t kTxBytes = 8192;

    TcpLink(PosixCore &core, std::string host, uint16_t port, Timing timing);
    TcpLink(PosixCore &core, std::string host, uint16_t port) : TcpLink(core, std::move(host), port, Timing{}) {}
    ~TcpLink();
    TcpLink(const TcpLink &) = delete;
    TcpLink &operator=(const TcpLink &) = delete;

    net::LinkKind kind() const override { return net::LinkKind::tcp; }
    bool up() const override { return state_ == State::up; }
    Status send(std::span<const uint8_t> envelope) override;
    void drop(net::DropReason) override { close("dropped by Net"); }
    void hold(bool on) override;
    size_t queued() const override { return tx_.size(); }

    /** Net and the UDP link that shares the hub's address. */
    void bind(net::Net &net, UdpLink *udp)
    {
        net_ = &net;
        udp_ = udp;
    }
    /** Where whole envelopes from the hub go (normally Net::receive). */
    std::function<void(std::span<const uint8_t>)> rx;
    /** A line for the log (connects, closes and why). */
    std::function<void(const std::string &)> log;

    /** Starts a connect when it is time (Runner loop). */
    void poll();
    /** The descriptor to wait on and the events wanted (-1 when none). */
    int fd() const { return fd_; }
    short events() const;
    void on_events(short revents);
    /** When poll() next has something to do (a retry or a connect timeout). */
    TimeUs next_deadline() const;

private:
    enum class State : uint8_t { idle, connecting, up };

    void start_connect();
    void connected();
    void close(const char *why);
    void flush();
    void read();
    /** Logs a line unless it repeats the previous one: a hub that is away is reported once, not every retry. */
    void say(const std::string &line)
    {
        if (log && line != last_said_) {
            log(line);
        }
        last_said_ = line;
    }
    void notify();

    PosixCore &core_;
    std::string host_;
    uint16_t port_;
    Timing timing_;
    net::Net *net_ = nullptr;
    UdpLink *udp_ = nullptr;
    State state_ = State::idle;
    int fd_ = -1;
    bool held_ = false;
    TimeUs retry_at_ = 0;
    TimeUs backoff_us_;
    TimeUs connect_deadline_ = kNever;
    TimeUs up_since_ = 0;
    std::vector<uint8_t> tx_;
    std::vector<uint8_t> rx_;
    std::string last_said_;
};

/** One datagram per envelope to the hub's address (the TCP link's last resolution); the node never listens on UDP. */
class UdpLink final : public net::Link
{
public:
    UdpLink();
    ~UdpLink();
    UdpLink(const UdpLink &) = delete;
    UdpLink &operator=(const UdpLink &) = delete;

    net::LinkKind kind() const override { return net::LinkKind::udp; }
    bool up() const override { return fd_ >= 0 && have_target_; }
    Status send(std::span<const uint8_t> envelope) override;

    void set_target(const sockaddr_in &to)
    {
        to_ = to;
        have_target_ = true;
    }

private:
    int fd_ = -1;
    bool have_target_ = false;
    sockaddr_in to_{};
};

/** `host` resolved to IPv4 (getaddrinfo, which may wait on mDNS): false when it does not resolve. */
bool resolve_ipv4(const std::string &host, uint16_t port, sockaddr_in &out);

}  // namespace fr::posix
