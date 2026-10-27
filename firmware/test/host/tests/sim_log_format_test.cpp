// The kit's log source (design m2-c2 D20, host side; sim/log_gen.cpp): its format strings are the firmware's own
// (fr_core's `ready id=…` banner, `alive fw=…` line and log_ota lines, core.cpp; fr_ota's `slot … open for …`,
// esp_flash.cpp), read
// from the sources here, so a firmware edit that the hub or a gate keys on fails this suite; and its ring: esp_log's
// line shape, drop-newest at 4 KB, the 384 B cut on a UTF-8 boundary, LOG's level kinds, the serial line getting the
// whole line, and a line from another thread formatted on the core task.
#include <cinttypes>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <type_traits>

#include "sim/node.hpp"
#include "tests/fake_core.hpp"
#include "tests/net_fakes.hpp"
#include "tests/test.hpp"

namespace {

using frsim::KitLogs;

/** The repository root, from this file's own path. */
std::string repo()
{
    std::string f = __FILE__;
    const size_t at = f.rfind("/firmware/test/host/tests/");
    return at == std::string::npos ? std::string(".") : f.substr(0, at);
}

std::string read(const std::string &rel)
{
    std::ifstream in(repo() + "/" + rel);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

/** A <cinttypes> macro by name, as the target's ESP_LOG format concatenates it. */
std::string macro(std::string_view name)
{
    if (name == "PRId64") {
        return PRId64;
    }
    if (name == "PRIu32") {
        return PRIu32;
    }
    if (name == "PRIu64") {
        return PRIu64;
    }
    if (name == "PRId32") {
        return PRId32;
    }
    return "<" + std::string(name) + ">";
}

/**
 * The format string of the ESP_LOGx call whose first string literal starts with `head`: its literals and the
 * <cinttypes> macros between them, concatenated as the compiler would; "" when there is none.
 */
std::string format_of(const std::string &src, const std::string &head)
{
    const size_t start = src.find("\"" + head);
    if (start == std::string::npos) {
        return {};
    }
    std::string out;
    size_t i = start;
    while (i < src.size()) {
        const char c = src[i];
        if (c == '"') {
            const size_t end = src.find('"', i + 1);
            out += src.substr(i + 1, end - i - 1);
            i = end + 1;
        } else if (c == ' ' || c == '\n' || c == '\t' || c == '\r') {
            ++i;
        } else if (std::isalpha(static_cast<unsigned char>(c)) || c == '_') {
            size_t end = i;
            while (end < src.size() && (std::isalnum(static_cast<unsigned char>(src[end])) || src[end] == '_')) {
                ++end;
            }
            out += macro(std::string_view(src).substr(i, end - i));
            i = end;
        } else {
            break;  // the `,` before the arguments, or the `)`
        }
    }
    return out;
}

struct Rig {
    frt::NetRig net;
    std::vector<std::string> serial;
    KitLogs logs{net.core, [this](std::string_view l) { serial.emplace_back(l); }};
};

}  // namespace

TEST(sim_log_formats_are_the_firmwares)
{
    const std::string core = read("firmware/components/fr_core/src/core.cpp");
    const std::string flash = read("firmware/components/fr_ota/src/esp/esp_flash.cpp");
    REQUIRE(!core.empty());
    REQUIRE(!flash.empty());
    CHECK_EQ(format_of(core, "ready id="), std::string(KitLogs::kReadyFmt));
    CHECK_EQ(format_of(core, "alive fw="), std::string(KitLogs::kAliveFmt));
    CHECK_EQ(format_of(flash, "slot %s open"), std::string(KitLogs::kSlotOpenFmt));
    // fr_core's log_ota (T-OTA's resume evidence keys on `ota: ACCEPT <job> (resumed)`), its suffixes included.
    CHECK_EQ(format_of(core, "ota: ACCEPT"), std::string(KitLogs::kOtaAcceptFmt));
    CHECK_EQ(format_of(core, "ota: REJECT"), std::string(KitLogs::kOtaRejectFmt));
    CHECK_EQ(format_of(core, "ota: RESULT"), std::string(KitLogs::kOtaResultFmt));
    CHECK_EQ(format_of(core, "ota: %s %.*s"), std::string(KitLogs::kOtaPhaseFmt));
    CHECK(core.find("? \" (resumed)\" : \"\"") != std::string::npos);
    CHECK(core.find("\" (no hub session: not sent)\"") != std::string::npos);
    // The tags they log under (TAG in each file), as KitLogs uses them.
    CHECK(core.find("constexpr const char *TAG = \"fr\";") != std::string::npos);
    CHECK(flash.find("constexpr const char *TAG = \"fr_ota\";") != std::string::npos);
}

TEST(sim_log_line_shape_and_serial_copy)
{
    Rig r;
    r.net.core.advance_to(1'234'000);
    CHECK(r.logs.log('I', "fr", "alive fw=0a0b0c0d0e0f id=02f200000001 uptime_s=1 heap=204800"));
    CHECK(!r.logs.log('X', "fr", "no such level"));
    CHECK(!r.logs.log('I', "", "no tag"));
    CHECK(!r.logs.log('I', "a tag", "a space in the tag"));
    r.net.core.run_ready();  // formatted on the core task
    REQUIRE_EQ(r.serial.size(), 1u);
    CHECK_EQ(r.serial[0], "I (1234) fr: alive fw=0a0b0c0d0e0f id=02f200000001 uptime_s=1 heap=204800");
    // Not attached to Net: the USB line only, no ring.
    fr::net::LogLine line;
    char scratch[512];
    CHECK(!r.logs.pop(line, scratch));
}

TEST(sim_log_ring_keeps_the_oldest_and_cuts_on_utf8)
{
    Rig r;
    r.logs.attach(r.net.net);
    r.net.core.advance_ms(5000);
    const auto now_ms = static_cast<uint32_t>(r.net.core.now() / 1000);
    // E..V are LOG kinds 1..5 (schema/protocol.yaml).
    for (const char lv : {'E', 'W', 'I', 'D', 'V'}) {
        CHECK(r.logs.log(lv, "t", std::string(1, lv)));
    }
    // A long line of 2-byte code points: cut at 384 B on a code-point boundary, whole on the serial line.
    std::string long_text;
    for (int i = 0; i < 300; ++i) {
        long_text += "\xc3\xa9";  // é
    }
    CHECK(r.logs.log('I', "t", long_text));
    r.net.core.run_ready();
    fr::net::LogLine line;
    char scratch[512];
    for (uint8_t kind = 1; kind <= 5; ++kind) {
        REQUIRE(r.logs.pop(line, scratch));
        CHECK_EQ(line.level, kind);
        CHECK_EQ(line.tag, "t");
        CHECK_EQ(line.pushed_ms, now_ms);
    }
    REQUIRE(r.logs.pop(line, scratch));
    CHECK_EQ(r.logs.stats().cut, 1u);
    CHECK(line.text.size() <= KitLogs::kLineMax);
    CHECK(line.text.size() >= KitLogs::kLineMax - 1);
    CHECK((static_cast<unsigned char>(line.text.back()) & 0xC0) != 0xC0);  // never the first half of a pair
    CHECK(fr::wire::utf8_valid({reinterpret_cast<const uint8_t *>(line.text.data()), line.text.size()}));
    CHECK(r.serial.back().size() > KitLogs::kLineMax);
    CHECK(!r.logs.pop(line, scratch));

    // Drop-newest: 4 KB of lines, then the next ones are refused and counted, the first kept.
    const std::string fill(90, 'x');
    for (int i = 0; i < 60; ++i) {
        r.logs.log('I', "t", std::to_string(i) + " " + fill);
    }
    r.net.core.run_ready();
    CHECK(r.logs.stats().ring_drop > 0);
    REQUIRE(r.logs.pop(line, scratch));
    CHECK(line.text.find(": 0 x") != std::string_view::npos);
    // The drain counts what the ring refused and cut (net_logs, the marker line), told at its next pop.
    CHECK_EQ(r.net.net.state().logs.ring_drop, r.logs.stats().ring_drop);
    CHECK_EQ(r.net.net.state().logs.cut, 1u);
}

TEST(sim_log_line_from_another_thread_is_formatted_on_the_core)
{
    Rig r;
    r.logs.attach(r.net.net);
    std::thread t([&r] { r.logs.log('W', "fr_ota", "slot ota_1 open for 1024 B at 0"); });
    t.join();
    CHECK(r.serial.empty());  // not until the core task ran its post
    r.net.core.run_ready();
    REQUIRE_EQ(r.serial.size(), 1u);
    CHECK(r.serial[0].starts_with("W ("));
    CHECK(r.serial[0].ends_with(") fr_ota: slot ota_1 open for 1024 B at 0"));
}

namespace {

/** An Out that drops its lines (NodeOtaHost's `ota_tx` lines are not under test here). */
class NullOut final : public frsim::Out
{
public:
    void line(std::string_view) override {}
};

}  // namespace

TEST(sim_log_node_ota_host_logs_fr_cores_ota_decisions)
{
    // The node's OTA decisions as fr_core's log_ota prints them (core.cpp), through the node's log source: a resumed
    // ACCEPT says so (T-OTA's node_resumed), a REJECT is a warning, a downloading STATUS says nothing, and a frame with
    // no hub session to go out on says it was not sent.
    Rig r;
    NullOut out;
    frsim::NodeSpec spec;
    frsim::Device dev(r.net.core, spec, {}, out);
    frsim::NodeOtaHost host(r.net.net, dev, spec, out);
    host.set_logs(&r.logs);
    auto send = [&host](const auto &msg) {
        uint8_t buf[128];
        fr::wire::Writer w(buf, sizeof(buf));
        fr::proto::encode(msg, w);
        static_cast<void>(host.send(std::remove_cvref_t<decltype(msg)>::kKind, w.bytes(), true));
    };
    send(fr::proto::OtaAccept{.job_id = "j_1", .code = static_cast<uint8_t>(fr::ota::Accept::resumed)});
    send(fr::proto::OtaAccept{.job_id = "j_2", .code = static_cast<uint8_t>(fr::ota::Accept::fresh)});
    send(fr::proto::OtaReject{.job_id = "j_3", .code = 4});
    send(fr::proto::OtaStatus{.job_id = "j_4", .state = static_cast<uint8_t>(fr::ota::Phase::downloading), .bytes = 1});
    send(fr::proto::OtaStatus{.job_id = "j_5", .state = static_cast<uint8_t>(fr::ota::Phase::staged), .bytes = 9});
    r.net.core.run_ready();
    REQUIRE_EQ(r.serial.size(), 4u);
    CHECK(r.serial[0].ends_with(" fr: ota: ACCEPT j_1 (resumed) (no hub session: not sent)"));
    CHECK(r.serial[1].ends_with(" fr: ota: ACCEPT j_2 (no hub session: not sent)"));
    CHECK(r.serial[2].starts_with("W ("));
    CHECK(r.serial[2].ends_with(" fr: ota: REJECT j_3 code=4 (no hub session: not sent)"));
    CHECK(r.serial[3].ends_with(" fr: ota: staged j_5"));
    // Without a log source: nothing (and no crash).
    host.set_logs(nullptr);
    send(fr::proto::OtaAccept{.job_id = "j_6", .code = 0});
    r.net.core.run_ready();
    CHECK_EQ(r.serial.size(), 4u);
}
