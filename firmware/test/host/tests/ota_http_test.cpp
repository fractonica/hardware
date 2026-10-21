// fr::ota::HttpGet (design c4 §3), the image GET the board and fr_net_node share, against a scripted server
// on loopback: the request (Range, Host, Connection: close), 200 and 206 (Content-Range must start at the
// offset asked for; a 200 to a Range request is skipped up to it), Content-Length or a body to the close,
// a body cut short, 404, other statuses, chunked refused, the head split across receives or too large, the
// timeouts on the head and the body, a refused connection and URLs it cannot take.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "fr/ota/http_get.hpp"
#include "tests/test.hpp"

namespace {

using fr::ota::HttpGet;
using Clock = std::chrono::steady_clock;

/** What the server does with one connection, after reading the request head. */
struct Reply {
    std::vector<std::string> pieces;  // written one by one, `gap_ms` apart
    int gap_ms = 0;
    int hold_ms = 0;  // then waits this long before it closes (a stalled answer)
};

/** A listening socket on 127.0.0.1 and a thread that answers the next connections with a script each. */
class Server
{
public:
    Server()
    {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t len = sizeof(a);
        if (fd_ < 0 || ::bind(fd_, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 || ::listen(fd_, 4) != 0 ||
            ::getsockname(fd_, reinterpret_cast<sockaddr *>(&a), &len) != 0) {
            frt::fail(__FILE__, __LINE__, "no loopback listener");
        }
        port_ = ntohs(a.sin_port);
    }
    ~Server()
    {
        join();
        ::close(fd_);
    }

    void serve(std::vector<Reply> replies)
    {
        thread_ = std::thread([this, replies = std::move(replies)] {
            for (const Reply &r : replies) {
                const int c = ::accept(fd_, nullptr, nullptr);
                if (c < 0) {
                    return;
                }
#ifdef SO_NOSIGPIPE
                const int one = 1;
                ::setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
                std::string req;
                char buf[512];
                while (req.find("\r\n\r\n") == std::string::npos) {
                    const ssize_t n = ::recv(c, buf, sizeof(buf), 0);
                    if (n <= 0) {
                        break;
                    }
                    req.append(buf, static_cast<size_t>(n));
                }
                requests.push_back(req);
                for (const std::string &p : r.pieces) {
                    ::send(c, p.data(), p.size(), 0);
                    if (r.gap_ms > 0) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(r.gap_ms));
                    }
                }
                if (r.hold_ms > 0) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(r.hold_ms));
                }
                ::close(c);
            }
        });
    }
    void join()
    {
        if (thread_.joinable()) {
            thread_.join();
        }
    }
    std::string url(const std::string &path = "/ota/ab12.bin") const
    {
        return "http://127.0.0.1:" + std::to_string(port_) + path;
    }
    uint16_t port() const { return port_; }

    std::vector<std::string> requests;  // read after join()

private:
    int fd_ = -1;
    uint16_t port_ = 0;
    std::thread thread_;
};

std::string head(int code, const std::string &reason, const std::string &headers)
{
    return "HTTP/1.1 " + std::to_string(code) + " " + reason + "\r\n" + headers + "Connection: close\r\n\r\n";
}

/** Reads the body until 0 or a failure (`failed` set); `chunk` bytes at most per read. */
std::string body(HttpGet &g, size_t chunk = 4096, bool *failed = nullptr)
{
    std::string out;
    std::vector<uint8_t> buf(chunk);
    for (int guard = 0; guard < 10'000; ++guard) {
        auto n = g.read(buf);
        if (!n) {
            if (failed != nullptr) {
                *failed = true;
            }
            return out;
        }
        if (*n == 0) {
            return out;
        }
        CHECK(*n <= chunk);
        out.append(reinterpret_cast<const char *>(buf.data()), *n);
    }
    return out;
}

}  // namespace

TEST(ota_http_get_206_from_a_range)
{
    Server s;
    s.serve({{.pieces = {head(206, "Partial Content",
                              "Content-Type: application/octet-stream\r\nContent-Length: 6\r\n"
                              "content-range: bytes 4-9/10\r\nAccept-Ranges: bytes\r\n") +
                         "456789"}}});
    HttpGet g;
    REQUIRE(g.start(s.url().c_str(), 4).has_value());
    CHECK_EQ(g.status(), 206);
    CHECK_EQ(body(g), "456789");  // the bytes that came with the head first, Content-Length decides the end
    uint8_t buf[16];
    auto again = g.read(buf);
    REQUIRE(again.has_value());
    CHECK_EQ(*again, 0u);
    g.close();
    s.join();
    REQUIRE_EQ(s.requests.size(), 1u);
    const std::string &req = s.requests[0];
    CHECK(req.starts_with("GET /ota/ab12.bin HTTP/1.1\r\n"));
    CHECK(req.find("\r\nHost: 127.0.0.1:" + std::to_string(s.port()) + "\r\n") != std::string::npos);
    CHECK(req.find("\r\nConnection: close\r\n") != std::string::npos);
    CHECK(req.find("\r\nRange: bytes=4-\r\n") != std::string::npos);
}

TEST(ota_http_get_200_in_pieces_without_a_range)
{
    Server s;
    // The blank line ending the head straddles two receives; the body arrives over several.
    s.serve({{.pieces = {"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r", "\n0123", "4567", "89"}, .gap_ms = 30}});
    HttpGet g;
    REQUIRE(g.start(s.url().c_str(), 0).has_value());
    CHECK_EQ(g.status(), 200);
    CHECK_EQ(body(g, 3), "0123456789");
    s.join();
    REQUIRE_EQ(s.requests.size(), 1u);
    CHECK(s.requests[0].find("Range:") == std::string::npos);
}

TEST(ota_http_get_200_to_a_range_skips_to_the_offset)
{
    Server s;
    s.serve({{.pieces = {head(200, "OK", "Content-Length: 10\r\n") + "01", "23456789"}, .gap_ms = 20}});
    HttpGet g;
    REQUIRE(g.start(s.url().c_str(), 4).has_value());
    CHECK_EQ(body(g), "456789");  // a server that ignores Range: what came before the offset is dropped
}

TEST(ota_http_get_body_to_the_close_without_a_length)
{
    Server s;
    s.serve({{.pieces = {"HTTP/1.0 200 OK\r\n\r\nabc", "def"}, .gap_ms = 20}});
    HttpGet g;
    REQUIRE(g.start(s.url().c_str(), 0).has_value());
    bool failed = false;
    CHECK_EQ(body(g, 4096, &failed), "abcdef");
    CHECK(!failed);
}

TEST(ota_http_get_body_cut_short_fails)
{
    Server s;
    s.serve({{.pieces = {head(206, "Partial Content", "Content-Length: 10\r\nContent-Range: bytes 100-109/110\r\n") + "01234"}}});
    HttpGet g;
    REQUIRE(g.start(s.url().c_str(), 100).has_value());
    bool failed = false;
    CHECK_EQ(body(g, 4096, &failed), "01234");
    CHECK(failed);  // the close before Content-Length: Ota re-issues its Range from what arrived
    CHECK_EQ(std::string_view(g.error()), "closed early");
}

TEST(ota_http_get_refuses_answers_it_cannot_use)
{
    struct Case {
        std::string response;
        uint32_t from;
        fr::Err err;
        int status;
        const char *error;
    };
    const std::vector<Case> cases = {
        {head(404, "Not Found", "Content-Length: 10\r\n") + "not found\n", 0, fr::Err::not_found, 404, "status"},
        {head(416, "Range Not Satisfiable", "Content-Range: bytes */10\r\n"), 20, fr::Err::failed, 416, "status"},
        {head(500, "Internal Server Error", ""), 0, fr::Err::failed, 500, "status"},
        // Another range than the one asked for would land at the wrong offset in the slot.
        {head(206, "Partial Content", "Content-Length: 10\r\nContent-Range: bytes 0-9/10\r\n"), 4, fr::Err::failed, 206, "range"},
        {head(206, "Partial Content", "Content-Length: 6\r\n"), 4, fr::Err::failed, 206, "range"},
        {head(200, "OK", "Transfer-Encoding: chunked\r\n") + "a\r\n0123456789\r\n0\r\n\r\n", 0, fr::Err::unsupported, 200,
         "chunked"},
        {head(200, "OK", "Content-Length: ten\r\n"), 0, fr::Err::failed, 200, "content-length"},
        {"HTTP/2 200\r\n\r\n", 0, fr::Err::failed, 0, "status"},
        {"SSH-2.0-OpenSSH\r\n\r\n", 0, fr::Err::failed, 0, "status"},
        {"HTTP/1.1 200 OK\r\nX-Pad: " + std::string(HttpGet::kHeadMax, 'x') + "\r\n\r\n", 0, fr::Err::failed, 0,
         "head too large"},
        {"HTTP/1.1 200 OK\r\nContent-Le", 0, fr::Err::failed, 0, "closed"},
    };
    for (const Case &c : cases) {
        Server s;
        s.serve({{.pieces = {c.response}}});
        HttpGet g;
        auto st = g.start(s.url().c_str(), c.from);
        REQUIRE(!st.has_value());
        CHECK(st.error() == c.err);
        CHECK_EQ(g.status(), c.status);
        CHECK_EQ(std::string_view(g.error()), c.error);
        uint8_t buf[8];
        CHECK(!g.read(buf).has_value());  // nothing open to read from
    }
}

TEST(ota_http_get_times_out_on_a_silent_server)
{
    {
        // No answer at all: the head's receive gives up after the timeout.
        Server s;
        s.serve({{.pieces = {}, .hold_ms = 1500}});
        HttpGet g(200);
        const auto t0 = Clock::now();
        auto st = g.start(s.url().c_str(), 0);
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        REQUIRE(!st.has_value());
        CHECK_EQ(std::string_view(g.error()), "timeout");
        CHECK(ms >= 150 && ms < 1200);
    }
    {
        // A body that stops: the read waits the timeout, then fails (and Ota re-issues its Range).
        Server s;
        s.serve({{.pieces = {head(200, "OK", "Content-Length: 100\r\n") + "0123"}, .hold_ms = 1500}});
        HttpGet g(200);
        REQUIRE(g.start(s.url().c_str(), 0).has_value());
        bool failed = false;
        const auto t0 = Clock::now();
        CHECK_EQ(body(g, 4096, &failed), "0123");
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        CHECK(failed);
        CHECK_EQ(std::string_view(g.error()), "timeout");
        CHECK(ms >= 150 && ms < 1200);
    }
}

TEST(ota_http_get_connection_refused_and_bad_urls)
{
    // A port nothing listens on (taken and released again): the connect fails at once.
    uint16_t port = 0;
    {
        Server s;
        port = s.port();
    }
    HttpGet g;
    auto st = g.start(("http://127.0.0.1:" + std::to_string(port) + "/ota/x.bin").c_str(), 0);
    REQUIRE(!st.has_value());
    CHECK(st.error() == fr::Err::failed);
    CHECK_EQ(std::string_view(g.error()), "connect");
    CHECK_EQ(g.status(), 0);
    // Only plain HTTP to a dotted IPv4 with a path: what Ota builds from the TCP session's address.
    for (const char *url : {"https://127.0.0.1:7422/ota/x.bin", "http://hub.local:7422/ota/x.bin", "http://127.0.0.1:7422",
                            "http://127.0.0.1:0/x", "http://127.0.0.1:70000/x", "http://:7422/x", "ftp://127.0.0.1/x"}) {
        auto bad = g.start(url, 0);
        REQUIRE(!bad.has_value());
        CHECK(bad.error() == fr::Err::invalid_args);
        CHECK_EQ(std::string_view(g.error()), "url");
    }
    CHECK(!g.start(nullptr, 0).has_value());
    const std::string long_path = "http://127.0.0.1:7422/" + std::string(300, 'a');
    CHECK(g.start(long_path.c_str(), 0).error() == fr::Err::invalid_args);
}

TEST(ota_http_get_reuses_the_object_for_the_next_get)
{
    Server s;
    s.serve({{.pieces = {head(200, "OK", "Content-Length: 4\r\n") + "ab"}},  // cut: the re-issue follows
             {.pieces = {head(206, "Partial Content", "Content-Length: 2\r\nContent-Range: bytes 2-3/4\r\n") + "cd"}}});
    HttpGet g;
    REQUIRE(g.start(s.url().c_str(), 0).has_value());
    bool failed = false;
    std::string got = body(g, 4096, &failed);
    CHECK(failed);
    REQUIRE(g.start(s.url().c_str(), static_cast<uint32_t>(got.size())).has_value());
    got += body(g);
    CHECK_EQ(got, "abcd");
    s.join();
    REQUIRE_EQ(s.requests.size(), 2u);
    CHECK(s.requests[1].find("\r\nRange: bytes=2-\r\n") != std::string::npos);
}
