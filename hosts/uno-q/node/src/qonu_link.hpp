// A client of qonu-link's socket (/run/qonu/link.sock): one JSON request per line, one reply line
// {"id","ok","result"|"error"} each. Calls are synchronous with a short timeout, on the node's one thread; a call that
// fails closes the connection, and the next one reconnects (qonu-link restarting is not fatal to the node).
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace qonu {

class LinkClient
{
public:
    explicit LinkClient(std::string socket_path, int timeout_ms = 1000)
        : path_(std::move(socket_path)), timeout_ms_(timeout_ms)
    {
    }
    ~LinkClient();
    LinkClient(const LinkClient &) = delete;
    LinkClient &operator=(const LinkClient &) = delete;

    /** `method` with `params_json` (an object): true when qonu-link answered ok. `error` gets why not. */
    bool call(std::string_view method, std::string_view params_json, std::string *error = nullptr);
    /** Failed calls since start (a counter for diag). */
    uint32_t failures() const { return failures_; }

private:
    bool connect_socket();
    void disconnect();

    std::string path_;
    int timeout_ms_;
    int fd_ = -1;
    uint64_t next_id_ = 1;
    std::string inbuf_;
    uint32_t failures_ = 0;
};

}  // namespace qonu
