// Generated dispatch, emit/report and the diag JSON codecs (design c2 §4) against fake capability
// implementations: defaults applied before the call, values outside a range or enum -> invalid_args,
// unknown commands -> unsupported, test-hook commands, RESULT fields in the Reply, events and STATE
// bodies handed to the Sink, traits-gated report_all.
#include <cstdlib>
#include <string>
#include <string_view>
#include <vector>

#include "button.hpp"
#include "cJSON.h"
#include "diag.hpp"
#include "diag_json.hpp"
#include "fr/envelope.hpp"
#include "led.hpp"
#include "node.hpp"
#include "ota.hpp"
#include "tests/test.hpp"

using fr::Err;
using fr::Status;
using fr::cap::Priority;
using fr::cap::Reply;
using frt::from_hex;

namespace {

struct Frame {
    bool event;
    uint8_t port;
    uint8_t id;
    Priority prio;
    std::vector<uint8_t> body;
    fr::TimeUs at;
};

class RecordingSink final : public fr::cap::Sink
{
public:
    void event(uint8_t port, uint8_t event_id, Priority prio, std::span<const uint8_t> fields, fr::TimeUs at) override
    {
        frames.push_back({true, port, event_id, prio, {fields.begin(), fields.end()}, at});
    }
    void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, fr::TimeUs at) override
    {
        frames.push_back({false, port, prop_id, Priority::normal, {value.begin(), value.end()}, at});
    }

    std::vector<Frame> frames;
};

class FakeLed final : public fr::cap::Led
{
public:
    Status set(const fr::cap::LedSetArgs &a) override
    {
        ++sets;
        last_set = a;
        return result;
    }
    Status toggle() override
    {
        ++toggles;
        return result;
    }
    Status blink(const fr::cap::LedBlinkArgs &a) override
    {
        ++blinks;
        last_blink = a;
        return result;
    }
    Status stop() override
    {
        ++stops;
        return result;
    }
    bool on() const override { return on_; }
    uint8_t brightness() const override { return brightness_; }
    uint32_t color() const override { return color_; }
    fr::cap::LedTraits traits() const override { return traits_; }

    using Led::emit_effect_done;
    using Led::report_on;

    Status result{};
    int sets = 0, toggles = 0, blinks = 0, stops = 0;
    fr::cap::LedSetArgs last_set{};
    fr::cap::LedBlinkArgs last_blink{};
    bool on_ = true;
    uint8_t brightness_ = 64;
    uint32_t color_ = 0x00FF00;
    fr::cap::LedTraits traits_{};
};

class FakeButton final : public fr::cap::Button
{
public:
    Status inject(const fr::cap::ButtonInjectArgs &a) override
    {
        injected.push_back(a.gesture);
        return {};
    }
    bool pressed() const override { return false; }
    fr::cap::ButtonTraits traits() const override { return {}; }

    using Button::emit_down;
    using Button::emit_long_press;
    using Button::emit_up;
    using Button::report_pressed;

    std::vector<fr::cap::ButtonGesture> injected;
};

class FakeDiag final : public fr::cap::Diag
{
public:
    std::expected<fr::cap::DiagExecResult, Err> exec(const fr::cap::DiagExecArgs &a) override
    {
        line = std::string(a.line);
        if (line == "big") {
            json.assign(1400, 'x');
        } else if (line == "fail") {
            return std::unexpected(Err::busy);
        } else {
            json = R"({"ok":true})";
        }
        // The result is a view into this object, encoded by dispatch before exec's caller returns.
        return fr::cap::DiagExecResult{.json = json};
    }

    using Diag::emit_mark;

    std::string line;
    std::string json;
};

class FakeNode final : public fr::cap::Node
{
public:
    Status identify(const fr::cap::NodeIdentifyArgs &a) override
    {
        identify_ms = a.ms;
        return {};
    }
    Status describe() override { return std::unexpected(Err::unsupported); }
    Status reboot(const fr::cap::NodeRebootArgs &a) override
    {
        reboot_bootloader = a.bootloader;
        ++reboots;
        return {};
    }
    Status set_alias(const fr::cap::NodeSetAliasArgs &a) override
    {
        alias = std::string(a.alias);
        alias_rev = a.rev;
        return {};
    }
    Status set_groups(const fr::cap::NodeSetGroupsArgs &a) override
    {
        groups.assign(a.groups.begin(), a.groups.end());
        return {};
    }
    Status net_set(const fr::cap::NodeNetSetArgs &a) override
    {
        has_bssid = a.has_bssid;
        return {};
    }
    Status get_state() override
    {
        ++get_states;
        return {};
    }
    Status bind_set() override { return std::unexpected(Err::unsupported); }
    Status bind_clear(const fr::cap::NodeBindClearArgs &) override { return std::unexpected(Err::unsupported); }
    Status bind_list() override { return std::unexpected(Err::unsupported); }

    uint16_t identify_ms = 0;
    bool reboot_bootloader = true;
    int reboots = 0;
    std::string alias;
    uint32_t alias_rev = 0;
    std::vector<uint16_t> groups;
    bool has_bssid = false;
    int get_states = 0;
};

class FakeOta final : public fr::cap::Ota
{
};

Status run(fr::cap::Capability &cap, uint8_t cmd, std::string_view args_hex)
{
    Reply reply;
    return cap.dispatch(cmd, from_hex(args_hex), reply);
}

Err err_of(const Status &s)
{
    return s ? Err{} : s.error();
}

}  // namespace

// ---- dispatch ----

TEST(dispatch_identity)
{
    FakeLed led;
    CHECK_EQ(led.cap_id(), 0x0002);
    CHECK_EQ(std::string_view(led.type_name()), "fr.led");
    CHECK_EQ(led.version().major, 1);
    CHECK_EQ(led.version().minor, 0);
    FakeNode node;
    CHECK_EQ(node.cap_id(), 0x00F0);
}

TEST(dispatch_decodes_args_and_applies_defaults)
{
    FakeLed led;
    REQUIRE(run(led, fr::cap::Led::kCmdSet, "08 01 18 80 fe 03").has_value());
    CHECK_EQ(led.sets, 1);
    CHECK(led.last_set.on);
    CHECK(!led.last_set.has_brightness);
    CHECK(led.last_set.has_color);
    CHECK_EQ(led.last_set.color, 0x00FF00);

    REQUIRE(run(led, fr::cap::Led::kCmdBlink, "").has_value());
    CHECK_EQ(led.last_blink.on_ms, 200);
    CHECK_EQ(led.last_blink.off_ms, 200);
    CHECK_EQ(led.last_blink.count, 3);
    CHECK(!led.last_blink.has_color);

    REQUIRE(run(led, fr::cap::Led::kCmdBlink, "18 00").has_value());  // count 0 = until stop/set
    CHECK_EQ(led.last_blink.count, 0);

    FakeNode node;
    REQUIRE(run(node, fr::cap::Node::kCmdIdentify, "").has_value());
    CHECK_EQ(node.identify_ms, 3000);
    REQUIRE(run(node, fr::cap::Node::kCmdReboot, "").has_value());
    CHECK(!node.reboot_bootloader);
    REQUIRE(run(node, fr::cap::Node::kCmdSetAlias, "0a 05 70 61 64 2d 32 10 07").has_value());
    CHECK_EQ(node.alias, "pad-2");
    CHECK_EQ(node.alias_rev, 7);
    REQUIRE(run(node, fr::cap::Node::kCmdSetGroups, "0a 03 81 e0 03").has_value());
    REQUIRE_EQ(node.groups.size(), 1);
    CHECK_EQ(node.groups[0], 0xF001);
    REQUIRE(run(node, fr::cap::Node::kCmdNetSet, "0a 03 6c 61 62 1a 00").has_value());
    CHECK(node.has_bssid);
    REQUIRE(run(node, fr::cap::Node::kCmdGetState, "").has_value());
    CHECK_EQ(node.get_states, 1);
}

TEST(dispatch_ranges_are_invalid_args)
{
    FakeLed led;
    CHECK_EQ(err_of(run(led, fr::cap::Led::kCmdBlink, "08 09")), Err::invalid_args);        // on_ms 9 < 10
    CHECK_EQ(err_of(run(led, fr::cap::Led::kCmdBlink, "08 91 4e")), Err::invalid_args);     // on_ms 10001
    CHECK_EQ(err_of(run(led, fr::cap::Led::kCmdBlink, "18 e9 07")), Err::invalid_args);     // count 1001
    CHECK_EQ(led.blinks, 0);
    CHECK(run(led, fr::cap::Led::kCmdBlink, "08 0a 10 90 4e 18 e8 07").has_value());       // 10, 10000, 1000
    CHECK_EQ(led.blinks, 1);
    CHECK_EQ(led.last_blink.off_ms, 10000);
}

TEST(dispatch_malformed_args_are_invalid_args)
{
    FakeLed led;
    CHECK_EQ(err_of(run(led, fr::cap::Led::kCmdSet, "08")), Err::invalid_args);
    CHECK_EQ(err_of(run(led, fr::cap::Led::kCmdSet, "10 ac 02")), Err::invalid_args);  // brightness 300
    CHECK_EQ(err_of(run(led, fr::cap::Led::kCmdToggle, "ff")), Err::invalid_args);
    CHECK_EQ(led.sets + led.toggles, 0);
    // A command without fields still skips unknown ones (a newer hub may send them).
    CHECK(run(led, fr::cap::Led::kCmdToggle, "08 01").has_value());
    CHECK_EQ(led.toggles, 1);
}

TEST(dispatch_unknown_commands_are_unsupported)
{
    FakeLed led;
    CHECK_EQ(err_of(run(led, 0, "")), Err::unsupported);
    CHECK_EQ(err_of(run(led, 9, "")), Err::unsupported);
    CHECK_EQ(err_of(run(led, 63, "08 01")), Err::unsupported);
    FakeOta ota;
    CHECK_EQ(err_of(run(ota, 1, "")), Err::unsupported);
}

TEST(dispatch_returns_the_command_status)
{
    FakeLed led;
    led.result = std::unexpected(Err::busy);
    CHECK_EQ(err_of(run(led, fr::cap::Led::kCmdStop, "")), Err::busy);
    CHECK_EQ(led.stops, 1);
}

TEST(dispatch_test_hook_commands)
{
    // The host suite builds with FR_TEST_HOOKS=1; release builds compile inject out (-> unsupported).
    static_assert(FR_TEST_HOOKS == 1);
    FakeButton button;
    REQUIRE(run(button, fr::cap::Button::kCmdInject, "08 01").has_value());
    REQUIRE(run(button, fr::cap::Button::kCmdInject, "").has_value());
    REQUIRE_EQ(button.injected.size(), 2);
    CHECK(button.injected[0] == fr::cap::ButtonGesture::double_click);
    CHECK(button.injected[1] == fr::cap::ButtonGesture::click);
    CHECK_EQ(err_of(run(button, fr::cap::Button::kCmdInject, "08 07")), Err::invalid_args);  // unknown member
    CHECK_EQ(button.injected.size(), 2);
}

TEST(dispatch_result_fields_go_to_the_reply)
{
    FakeDiag diag;
    Reply reply;
    REQUIRE(diag.dispatch(fr::cap::Diag::kCmdExec, from_hex("0a 04 69 6e 66 6f"), reply).has_value());
    CHECK_EQ(diag.line, "info");
    CHECK_BYTES(reply.bytes(), from_hex("0a 0b 7b 22 6f 6b 22 3a 74 72 75 65 7d"));
    const auto back = fr::cap::decode_diag_exec_result(reply.bytes());
    REQUIRE(back.has_value());
    CHECK_EQ(back->json, R"({"ok":true})");

    Reply busy;
    CHECK_EQ(err_of(diag.dispatch(fr::cap::Diag::kCmdExec, from_hex("0a 04 66 61 69 6c"), busy)), Err::busy);
    CHECK(busy.bytes().empty());

    // 1.4 kB of JSON does not fit the 200 B Reply: a failure, never truncated fields.
    Reply small;
    CHECK_EQ(err_of(diag.dispatch(fr::cap::Diag::kCmdExec, from_hex("0a 03 62 69 67"), small)), Err::failed);
}

TEST(dispatch_commands_without_result_leave_the_reply_empty)
{
    FakeLed led;
    Reply reply;
    REQUIRE(led.dispatch(fr::cap::Led::kCmdBlink, {}, reply).has_value());
    CHECK(reply.bytes().empty());
}

// ---- emit / report ----

TEST(emit_and_report_go_to_the_sink)
{
    RecordingSink sink;
    FakeLed led;
    led.emit_effect_done({.effect = fr::cap::LedEffect::blink});  // not attached yet: dropped
    led.attach(3, "status", sink);
    CHECK_EQ(led.port(), 3);
    CHECK_EQ(std::string_view(led.name()), "status");
    led.emit_effect_done({.effect = fr::cap::LedEffect::blink});
    led.report_on(true);
    led.report_on(false);
    REQUIRE_EQ(sink.frames.size(), 3);
    CHECK(sink.frames[0].event);
    CHECK_EQ(sink.frames[0].port, 3);
    CHECK_EQ(sink.frames[0].id, fr::cap::Led::kEventEffectDone);
    CHECK(sink.frames[0].prio == Priority::normal);
    CHECK_BYTES(sink.frames[0].body, from_hex("08 01"));
    CHECK(!sink.frames[1].event);
    CHECK_EQ(sink.frames[1].id, fr::cap::Led::kPropOn);
    CHECK_BYTES(sink.frames[1].body, from_hex("08 01"));
    CHECK_BYTES(sink.frames[2].body, from_hex(""));

    FakeButton button;
    button.attach(1, "boot", sink);
    sink.frames.clear();
    button.emit_down({});
    button.emit_up({.held_ms = 80});
    button.emit_long_press({.held_ms = 600});
    REQUIRE_EQ(sink.frames.size(), 3);
    CHECK(sink.frames[0].prio == Priority::realtime);
    CHECK(sink.frames[0].body.empty());
    CHECK(sink.frames[1].prio == Priority::realtime);
    CHECK_BYTES(sink.frames[1].body, from_hex("08 50"));
    CHECK(sink.frames[2].prio == Priority::normal);
    CHECK_EQ(sink.frames[2].id, fr::cap::Button::kEventLongPress);
}

TEST(emit_and_report_hand_the_sink_when_it_happened)
{
    RecordingSink sink;
    FakeButton button;
    button.attach(1, "boot", sink);
    button.emit_down({});  // no time: the Sink stamps it
    button.emit_down({}, 1234567);
    button.emit_up({.held_ms = 80}, 0x1'0000'0001);  // the Sink keeps the low 32 bits for t_us
    button.report_pressed(true, 99);
    button.report_all();
    REQUIRE_EQ(sink.frames.size(), 5);
    CHECK_EQ(sink.frames[0].at, fr::cap::kNowUs);
    CHECK_EQ(sink.frames[1].at, 1234567);
    CHECK_EQ(sink.frames[2].at, 0x1'0000'0001);
    CHECK_BYTES(sink.frames[2].body, from_hex("08 50"));
    CHECK(!sink.frames[3].event);
    CHECK_EQ(sink.frames[3].at, 99);
    CHECK_EQ(sink.frames[4].at, fr::cap::kNowUs);
}

TEST(emit_drops_a_body_that_does_not_fit)
{
    RecordingSink sink;
    FakeDiag diag;
    diag.attach(241, "diag", sink);
    std::string token(33, 'x');  // max 32
    diag.emit_mark({.token = token});
    CHECK(sink.frames.empty());
    token.pop_back();
    diag.emit_mark({.token = token});
    REQUIRE_EQ(sink.frames.size(), 1);
    CHECK_EQ(sink.frames[0].body.size(), 34);
}

TEST(report_all_honours_trait_requirements)
{
    RecordingSink sink;
    FakeLed led;
    led.attach(2, "status", sink);
    led.report_all();  // mono, not dimmable: `on` only
    REQUIRE_EQ(sink.frames.size(), 1);
    CHECK_EQ(sink.frames[0].id, fr::cap::Led::kPropOn);

    sink.frames.clear();
    led.traits_ = {.color = fr::cap::LedColorMode::rgb, .dimmable = true};
    led.report_all();
    REQUIRE_EQ(sink.frames.size(), 3);
    CHECK_EQ(sink.frames[0].id, fr::cap::Led::kPropOn);
    CHECK_EQ(sink.frames[1].id, fr::cap::Led::kPropBrightness);
    CHECK_BYTES(sink.frames[1].body, from_hex("08 40"));
    CHECK_EQ(sink.frames[2].id, fr::cap::Led::kPropColor);
    CHECK_BYTES(sink.frames[2].body, from_hex("08 80 fe 03"));
}

TEST(encode_traits_writes_the_descriptor_bytes)
{
    uint8_t buf[16];
    fr::wire::Writer w(buf, sizeof(buf));
    FakeLed led;
    led.traits_ = {.color = fr::cap::LedColorMode::rgb, .dimmable = true};
    led.encode_traits(w);
    CHECK_BYTES(w.bytes(), from_hex("08 01 10 01"));
    w.reset();
    FakeButton button;
    button.encode_traits(w);  // traits with non-zero defaults are always encoded
    CHECK_BYTES(w.bytes(), from_hex("08 01 10 02"));
    w.reset();
    FakeNode node;
    node.encode_traits(w);
    CHECK(w.bytes().empty());
}

// ---- diag JSON codecs ----

namespace {

struct Json {
    // As diag `call` parses its arguments.
    explicit Json(std::string_view text) : p(fr::cap::parse_args_json(text)) {}
    explicit Json(cJSON *j) : p(j) {}
    ~Json() { cJSON_Delete(p); }
    Json(const Json &) = delete;
    Json &operator=(const Json &) = delete;

    std::string print() const
    {
        if (p == nullptr) {
            return "<null>";
        }
        char *s = cJSON_PrintUnformatted(p);
        std::string out = s;
        cJSON_free(s);
        return out;
    }

    cJSON *p;
};

struct Encoded {
    Status status;
    uint8_t cmd_id = 0;
    std::vector<uint8_t> bytes;
};

Encoded encode_json(uint16_t cap, const char *cmd, std::string_view json)
{
    Json args(json);
    uint8_t buf[256];
    fr::wire::Writer w(buf, sizeof(buf));
    Encoded e;
    e.status = fr::cap::encode_args_json(cap, cmd, args.p, &e.cmd_id, w);
    e.bytes.assign(w.bytes().begin(), w.bytes().end());
    return e;
}

std::string decode_json(uint16_t cap, uint8_t cls, uint8_t member, std::string_view hex)
{
    const auto bytes = from_hex(hex);
    return Json(fr::cap::decode_to_json(cap, cls, member, bytes)).print();
}

}  // namespace

TEST(diag_json_encodes_args)
{
    const auto blink = encode_json(fr::cap::Led::kId, "blink", R"({"count":3,"color":16711680})");
    REQUIRE(blink.status.has_value());
    CHECK_EQ(blink.cmd_id, fr::cap::Led::kCmdBlink);
    CHECK_BYTES(blink.bytes, from_hex("08 c8 01 10 c8 01 18 03 20 80 80 fc 07"));

    const auto set = encode_json(fr::cap::Led::kId, "set", R"({"on":true,"color":65280})");
    REQUIRE(set.status.has_value());
    CHECK_BYTES(set.bytes, from_hex("08 01 18 80 fe 03"));

    const auto inject = encode_json(fr::cap::Button::kId, "inject", R"({"gesture":"double_click"})");
    REQUIRE(inject.status.has_value());
    CHECK_BYTES(inject.bytes, from_hex("08 01"));

    const auto groups = encode_json(fr::cap::Node::kId, "set_groups", R"({"groups":[61441]})");
    REQUIRE(groups.status.has_value());
    CHECK_BYTES(groups.bytes, from_hex("0a 03 81 e0 03"));

    const auto net = encode_json(fr::cap::Node::kId, "net_set", R"({"ssid":"lab","bssid":"A0b1c2d3e4f5"})");
    REQUIRE(net.status.has_value());
    CHECK_BYTES(net.bytes, from_hex("0a 03 6c 61 62 1a 06 a0 b1 c2 d3 e4 f5"));

    // Commands without fields take no arguments, null or {}.
    CHECK(encode_json(fr::cap::Led::kId, "toggle", "null").status.has_value());
    CHECK(encode_json(fr::cap::Led::kId, "toggle", "{}").status.has_value());
    Encoded none;
    uint8_t buf[8];
    fr::wire::Writer w(buf, sizeof(buf));
    CHECK(fr::cap::encode_args_json(fr::cap::Led::kId, "stop", nullptr, &none.cmd_id, w).has_value());
    CHECK_EQ(none.cmd_id, fr::cap::Led::kCmdStop);
}

TEST(diag_json_rejects_bad_args)
{
    const auto code = [](uint16_t cap, const char *cmd, const char *json) { return err_of(encode_json(cap, cmd, json).status); };
    CHECK_EQ(code(fr::cap::Led::kId, "blink", R"({"cuont":3})"), Err::invalid_args);       // unknown key
    CHECK_EQ(code(fr::cap::Led::kId, "blink", R"({"count":"3"})"), Err::invalid_args);     // wrong type
    CHECK_EQ(code(fr::cap::Led::kId, "blink", R"({"count":1.5})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Led::kId, "blink", R"({"on_ms":70000})"), Err::invalid_args);   // beyond u16
    CHECK_EQ(code(fr::cap::Led::kId, "blink", R"({"on_ms":-1})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Led::kId, "blink", "[1]"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Led::kId, "set", R"({"on":1})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Led::kId, "toggle", R"({"x":1})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Button::kId, "inject", R"({"gesture":"triple"})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Node::kId, "set_groups", R"({"groups":[1,2,3,4,5,6,7,8,9]})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Node::kId, "net_set", R"({"bssid":"a0b"})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Node::kId, "set_alias", R"({"alias":"0123456789012345678901234567890123"})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Led::kId, "explode", "{}"), Err::unsupported);
    CHECK_EQ(code(0x7777, "blink", "{}"), Err::not_found);
    // Ranges, as the decoders check them.
    CHECK_EQ(code(fr::cap::Led::kId, "blink", R"({"on_ms":5})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Led::kId, "blink", R"({"count":1001})"), Err::invalid_args);
    CHECK(encode_json(fr::cap::Led::kId, "blink", R"({"on_ms":10,"off_ms":10000,"count":0})").status.has_value());
}

TEST(diag_json_takes_the_json_schema_form)
{
    // As the generated JSON Schemas and the TS encodeMember: enums by member name only, and a field is a
    // value or left out (null is not absent).
    const auto code = [](uint16_t cap, const char *cmd, const char *json) { return err_of(encode_json(cap, cmd, json).status); };
    CHECK_EQ(code(fr::cap::Button::kId, "inject", R"({"gesture":3})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Led::kId, "set", R"({"on":true,"color":null})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Led::kId, "set", R"({"on":null})"), Err::invalid_args);
    CHECK_EQ(code(fr::cap::Node::kId, "set_alias", R"({"alias":null})"), Err::invalid_args);
    const auto press = encode_json(fr::cap::Button::kId, "inject", R"({"gesture":"press"})");
    REQUIRE(press.status.has_value());
    CHECK_BYTES(press.bytes, from_hex("08 03"));
}

TEST(diag_json_refuses_u0000)
{
    // cJSON keeps \u0000 inside the string, where a C string would end: `ab\u0000cd` must not set "ab".
    CHECK(Json(std::string_view(R"({"alias":"ab\u0000cd"})")).p == nullptr);
    CHECK(Json(std::string_view(R"({"al\u0000ias":"ab"})")).p == nullptr);
    CHECK(Json(std::string_view("{\"alias\":\"ab\0cd\"}", 17)).p == nullptr);  // a raw NUL
    // An escaped backslash before the text u0000 is an ordinary string.
    const auto ok = encode_json(fr::cap::Node::kId, "set_alias", R"({"alias":"a\\u0000"})");
    REQUIRE(ok.status.has_value());
    CHECK_BYTES(ok.bytes, from_hex("0a 07 61 5c 75 30 30 30 30"));
    // Decoded strings holding a NUL have no cJSON form: refused, not printed cut short.
    using fr::cap::Node;
    CHECK_EQ(decode_json(Node::kId, fr::wire::kClsCmd, Node::kCmdSetAlias, "0a 05 61 62 00 63 64"), "<null>");
    CHECK_EQ(decode_json(Node::kId, fr::wire::kClsCmd, Node::kCmdSetAlias, "0a 04 61 62 63 64"), R"({"alias":"abcd","rev":0})");
}

TEST(diag_json_call_runs_through_dispatch)
{
    // `call status.blink {"count":3}` on the node: JSON -> args -> dispatch -> RESULT body -> JSON.
    const auto args = encode_json(fr::cap::Led::kId, "blink", R"({"count":3})");
    REQUIRE(args.status.has_value());
    FakeLed led;
    Reply reply;
    REQUIRE(led.dispatch(args.cmd_id, args.bytes, reply).has_value());
    CHECK_EQ(led.last_blink.count, 3);
    const Json result(fr::cap::decode_to_json(fr::cap::Led::kId, fr::wire::kClsResult, args.cmd_id, reply.bytes()));
    CHECK_EQ(result.print(), "{}");
}

TEST(diag_json_decodes_bodies)
{
    using fr::cap::Button;
    using fr::cap::Diag;
    using fr::cap::Led;
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsEvent, Led::kEventEffectDone, "08 01"), R"({"effect":"blink"})");
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsEvent, Led::kEventEffectDone, "08 05"), "<null>");  // not a member
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsState, Led::kPropOn, "08 01"), R"({"on":true})");
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsState, Led::kPropColor, ""), R"({"color":0})");
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsCmd, Led::kCmdSet, "08 01 18 80 fe 03"), R"({"on":true,"color":65280})");
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsCmd, Led::kCmdBlink, ""), R"({"on_ms":200,"off_ms":200,"count":3})");
    CHECK_EQ(decode_json(Button::kId, fr::wire::kClsEvent, Button::kEventUp, "08 50"), R"({"held_ms":80})");
    CHECK_EQ(decode_json(Button::kId, fr::wire::kClsEvent, Button::kEventDown, ""), "{}");
    // An implicit zero is the absent field, exempt from count's range 1..5 (design c2 §3), as in TS.
    CHECK_EQ(decode_json(Button::kId, fr::wire::kClsEvent, Button::kEventClick, ""), R"({"count":0})");
    CHECK_EQ(decode_json(Button::kId, fr::wire::kClsEvent, Button::kEventClick, "08 00"), R"({"count":0})");
    CHECK_EQ(decode_json(Button::kId, fr::wire::kClsEvent, Button::kEventClick, "08 06"), "<null>");
    CHECK_EQ(decode_json(Diag::kId, fr::wire::kClsResult, Diag::kCmdExec, "0a 02 7b 7d"), R"({"json":"{}"})");
    CHECK_EQ(decode_json(fr::cap::Node::kId, fr::wire::kClsCmd, fr::cap::Node::kCmdNetSet, "1a 02 a0 b1"),
             R"({"ssid":"","pass":"","bssid":"a0b1"})");
    // Unknown members, classes and capabilities, and bodies that do not decode: nullptr.
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsEvent, 9, ""), "<null>");
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsLog, 1, ""), "<null>");
    CHECK_EQ(decode_json(0x7777, fr::wire::kClsEvent, 1, ""), "<null>");
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsState, Led::kPropOn, "08 02"), "<null>");
    CHECK_EQ(decode_json(Led::kId, fr::wire::kClsResult, Led::kCmdBlink, "ff"), "<null>");
}

TEST(diag_json_prints_traits)
{
    // `caps` in every build: descriptor bytes -> JSON, refusing what valid() rejects.
    const auto traits = [](uint16_t cap, std::string_view hex) {
        const auto bytes = from_hex(hex);
        return Json(fr::cap::traits_to_json(cap, bytes)).print();
    };
    CHECK_EQ(traits(fr::cap::Button::kId, "08 01 10 02"), R"({"long_press":true,"multi_press_max":2})");
    CHECK_EQ(traits(fr::cap::Led::kId, "08 01 10 01"), R"({"color":"rgb","dimmable":true})");
    CHECK_EQ(traits(fr::cap::Led::kId, ""), R"({"color":"mono","dimmable":false})");
    CHECK_EQ(traits(fr::cap::Node::kId, ""), "{}");                // a capability without traits
    CHECK_EQ(traits(fr::cap::Led::kId, "08 07"), "<null>");        // not a LedColorMode member
    CHECK_EQ(traits(fr::cap::Button::kId, "0a"), "<null>");        // does not decode
    CHECK_EQ(traits(0x7777, ""), "<null>");                        // unknown capability
}

namespace {

int g_live_json_allocs = 0;

void *counting_malloc(size_t n)
{
    ++g_live_json_allocs;
    return std::malloc(n);
}

void counting_free(void *p)
{
    if (p != nullptr) {
        --g_live_json_allocs;
    }
    std::free(p);
}

}  // namespace

// LeakSanitizer does not run on macOS, so count cJSON's allocations instead.
TEST(diag_json_frees_what_it_allocates)
{
    cJSON_Hooks hooks{counting_malloc, counting_free};
    cJSON_InitHooks(&hooks);
    for (int i = 0; i < 3; ++i) {
        encode_json(fr::cap::Node::kId, "net_set", R"({"ssid":"lab","bssid":"a0b1c2d3e4f5","hub_host":"h"})");
        encode_json(fr::cap::Led::kId, "blink", R"({"count":"x"})");
        encode_json(fr::cap::Node::kId, "set_groups", R"({"groups":[1,2,3,4,5,6,7,8,9]})");
        decode_json(fr::cap::Node::kId, fr::wire::kClsCmd, fr::cap::Node::kCmdSetGroups, "0a 03 81 e0 03");
        decode_json(fr::cap::Led::kId, fr::wire::kClsState, fr::cap::Led::kPropColor, "08 80 fe 03");
        decode_json(fr::cap::Led::kId, fr::wire::kClsCmd, fr::cap::Led::kCmdSet, "08 02");
        decode_json(fr::cap::Diag::kId, fr::wire::kClsResult, fr::cap::Diag::kCmdExec, "0a 02 7b 7d");
        const auto led_traits = from_hex("08 01 10 01");
        cJSON_Delete(fr::cap::traits_to_json(fr::cap::Led::kId, led_traits));
    }
    cJSON_InitHooks(nullptr);
    CHECK_EQ(g_live_json_allocs, 0);
}
