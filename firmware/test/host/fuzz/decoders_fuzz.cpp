// Fuzz targets for the generated codecs (T-CODEC, spec 05 §5.18): one per system message, capability
// struct and property STATE body ("gen.<vector type>", from gen/decoders.inc), the full serial path
// (line -> envelope -> message or capability body -> JSON, or line -> GW_*/LINK_* body) and the diag JSON
// argument encoder.
// A target's corpus is every golden vector of its type in vectors.inc order, error and decode-only ones
// and envelope bodies included (every message and capability sample when a type has none); the TS twin
// (packages/protocol/test/gen.fuzz.test.ts) builds the same list, since the corpus order picks cases.
//
// Per-decoder invariants: a decoded value re-encodes within kMaxSize, the re-encoded bytes decode to an
// equal value and encode to the same bytes again (canonical form). The digest folds the outcome (ok or
// the DecodeErr) and the re-encoded bytes, so a TS twin that follows the same codec rules over the same
// cases reaches the same digest.
#include <cstring>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

#include "cJSON.h"
#include "catalog.hpp"
#include "diag_json.hpp"
#include "fr/envelope.hpp"
#include "fr/serial_line.hpp"
#include "fuzz/fuzz.hpp"
#include "vectors.inc"

namespace {

struct Sample {
    std::string type;
    frf::Bytes bytes;
};

struct Collector {
    std::vector<Sample> out;

    template <class T, class Enc, class Dec>
    void value(const char *, const char *type, const T &, Enc, Dec, std::string_view hex, bool)
    {
        out.push_back({type, frf::from_hex(hex)});
    }
    // Error cases are good corpus entries: they sit right at a decoder's boundaries.
    template <class Dec>
    void error(const char *, const char *type, Dec, std::string_view hex, fr::wire::DecodeErr)
    {
        const std::string_view t = type;
        if (t.starts_with("serial")) {
            out.push_back({"serial", frf::from_hex(hex)});
        } else if (t.starts_with("envelope")) {
            out.push_back({"envelope", frf::from_hex(hex)});
        } else {
            out.push_back({type, frf::from_hex(hex)});
        }
    }
    void header(const char *, const fr::wire::Header &, std::string_view hex) { out.push_back({"header", frf::from_hex(hex)}); }
    void envelope(const char *, const fr::wire::Header &, fr::wire::PrefixType, uint32_t, const fr::wire::ResultPrefix &,
                  std::span<const uint8_t>, std::string_view hex)
    {
        out.push_back({"envelope", frf::from_hex(hex)});
    }
    void serial(const char *, uint8_t, std::span<const uint8_t>, std::string_view, std::string_view input, bool)
    {
        out.push_back({"serial", frf::from_text(input)});
    }
};

const std::vector<Sample> &samples()
{
    static const std::vector<Sample> all = [] {
        Collector c;
        fr_vectors::for_each(c);
        return c.out;
    }();
    return all;
}

bool is_body(const std::string &type)
{
    return type != "header" && type != "envelope" && type != "serial";
}

std::vector<frf::Bytes> corpus_for(const char *type)
{
    std::vector<frf::Bytes> mine;
    std::vector<frf::Bytes> bodies;
    for (const auto &s : samples()) {
        if (s.type == type) {
            mine.push_back(s.bytes);
        } else if (is_body(s.type)) {
            bodies.push_back(s.bytes);
        }
    }
    return mine.empty() ? bodies : mine;
}

void fold(std::span<const uint8_t> b, frf::Digest &d)
{
    d.u32(static_cast<uint32_t>(b.size()));
    for (const uint8_t x : b) {
        d.u8(x);
    }
}

bool same_bytes(std::span<const uint8_t> a, std::span<const uint8_t> b)
{
    return a.size() == b.size() && (a.empty() || std::memcmp(a.data(), b.data(), a.size()) == 0);
}

/** Decode, then check the round-trip invariants of whatever decoded. */
template <class T, class Enc, class Dec>
void roundtrip(std::span<const uint8_t> data, frf::Digest &d, Enc enc, Dec dec, size_t max_size)
{
    const auto v = dec(data);
    if (!v) {
        d.err(v.error());
        return;
    }
    d.ok();
    std::vector<uint8_t> buf(max_size + 1);
    fr::wire::Writer w(buf.data(), max_size);
    enc(*v, w);
    if (w.overflow()) {
        frf::fail("a decoded value does not re-encode within kMaxSize");
    }
    fold(w.bytes(), d);
    const auto again = dec(w.bytes());
    if (!again) {
        frf::fail("re-encoded bytes do not decode");
    }
    // Bitwise for a float STATE value (structs compare their floats so too): NaN equals itself.
    if (!fr::proto::same(*again, *v)) {
        frf::fail("the round trip changed the value");
    }
    std::vector<uint8_t> buf2(max_size + 1);
    fr::wire::Writer w2(buf2.data(), max_size);
    enc(*again, w2);
    if (!same_bytes(w.bytes(), w2.bytes())) {
        frf::fail("encoding is not canonical");
    }
}

const auto kEncode = [](const auto &x, fr::wire::Writer &w) { return encode(x, w); };

}  // namespace

// One target per generated decoder.
#define FR_GEN_DECODER(ident, type, T, decode)                                                  \
    static std::vector<frf::Bytes> corpus_##ident() { return corpus_for(type); }                \
    FUZZ_TARGET(gen_##ident, "gen." type, corpus_##ident)                                       \
    {                                                                                           \
        roundtrip<T>(data, d, kEncode, decode, T::kMaxSize);                                    \
    }
#define FR_GEN_STATE_DECODER(ident, type, V, encode_fn, decode_fn, max_size)                    \
    static std::vector<frf::Bytes> corpus_##ident() { return corpus_for(type); }                \
    FUZZ_TARGET(gen_##ident, "gen." type, corpus_##ident)                                       \
    {                                                                                           \
        roundtrip<V>(data, d, encode_fn, decode_fn, max_size);                                  \
    }
#include "decoders.inc"
#undef FR_GEN_DECODER
#undef FR_GEN_STATE_DECODER

namespace {

std::vector<frf::Bytes> serial_corpus()
{
    std::vector<frf::Bytes> out;
    for (const auto &s : samples()) {
        if (s.type == "serial") {
            out.push_back(s.bytes);
        } else if (s.type == "envelope") {
            // Envelope vectors as ENV lines, so the corpus reaches every class.
            char line[fr::wire::kMaxLine];
            const size_t n = fr::wire::encode_line(fr::wire::kSerialEnv, s.bytes, line);
            out.push_back(frf::Bytes(line, line + n));
        }
    }
    return out;
}

/** A system message body through the decoder its class and kind select (LOG.LINE serves every kind). */
template <class T, class Dec>
bool try_message(uint8_t cls, uint8_t kind, std::span<const uint8_t> body, Dec dec, frf::Digest &d)
{
    bool match = false;
    if constexpr (requires { T::kCls; T::kKind; }) {
        match = T::kCls == cls && T::kKind == kind;
    } else if constexpr (requires { T::kCls; }) {
        match = T::kCls == cls;
    }
    if (match) {
        roundtrip<T>(body, d, kEncode, dec, T::kMaxSize);
    }
    return match;
}

void message_body(uint8_t cls, uint8_t kind, std::span<const uint8_t> body, frf::Digest &d)
{
    bool hit = false;
#define FR_GEN_DECODER(ident, type, T, decode) hit = hit || try_message<T>(cls, kind, body, decode, d);
#define FR_GEN_STATE_DECODER(ident, type, V, encode_fn, decode_fn, max_size)
#include "decoders.inc"
#undef FR_GEN_DECODER
#undef FR_GEN_STATE_DECODER
    if (!hit) {
        d.u8(0xEE);
    }
}

/** A serial body through the codec its frame type selects (design m2-c4-gateway D1). */
template <class T, class Dec>
bool try_serial(uint8_t type, std::span<const uint8_t> body, Dec dec, frf::Digest &d)
{
    bool match = false;
    if constexpr (requires { T::kType; }) {
        match = T::kType == type;
    } else if constexpr (std::is_same_v<T, fr::proto::GwStatus>) {
        match = type == fr::proto::kSerialTypeOfGwStatus;
    } else if constexpr (std::is_same_v<T, fr::proto::GwCmd>) {
        match = type == fr::proto::kSerialTypeOfGwCmd;
    } else if constexpr (std::is_same_v<T, fr::proto::GwRsp>) {
        match = type == fr::proto::kSerialTypeOfGwRsp;
    }
    if (match) {
        roundtrip<T>(body, d, kEncode, dec, T::kMaxSize);
    }
    return match;
}

void serial_body(uint8_t type, std::span<const uint8_t> body, frf::Digest &d)
{
    bool hit = false;
#define FR_GEN_DECODER(ident, type_name, T, decode) hit = hit || try_serial<T>(type, body, decode, d);
#define FR_GEN_STATE_DECODER(ident, type_name, V, encode_fn, decode_fn, max_size)
#include "decoders.inc"
#undef FR_GEN_DECODER
#undef FR_GEN_STATE_DECODER
    if (!hit) {
        d.u8(0xEE);
    }
}

/** A capability body as JSON; the capability is picked by port, as a board's port table would. */
void capability_body(const fr::wire::Header &h, std::span<const uint8_t> body, frf::Digest &d)
{
    const auto caps = fr::cap::all_caps();
    const auto &cap = caps[h.port % caps.size()];
    cJSON *json = fr::cap::decode_to_json(cap.id, h.cls, h.kind, body);
    if (json == nullptr) {
        d.u8(0xEE);
        return;
    }
    char *text = cJSON_PrintUnformatted(json);
    if (text == nullptr) {
        frf::fail("cJSON_PrintUnformatted failed");
    }
    fold({reinterpret_cast<const uint8_t *>(text), std::strlen(text)}, d);
    cJSON_free(text);
    cJSON_Delete(json);
}

}  // namespace

FUZZ_TARGET(gen_serial_path, "gen.serial_path", serial_corpus)
{
    uint8_t scratch[fr::wire::kMaxLineFrame];
    const std::string_view line(reinterpret_cast<const char *>(data.data()), data.size());
    const auto frame = fr::wire::decode_line(line, scratch);
    if (!frame) {
        d.err(frame.error());
        return;
    }
    d.ok();
    d.u8(frame->type);
    if (frame->type != fr::wire::kSerialEnv) {
        serial_body(frame->type, frame->body, d);
        return;
    }
    const auto env = fr::wire::unpack_envelope(frame->body);
    if (!env) {
        d.err(env.error());
        return;
    }
    d.ok();
    switch (env->header.cls) {
    case fr::wire::kClsEvent:
    case fr::wire::kClsCmd:
    case fr::wire::kClsResult:
    case fr::wire::kClsState:
        capability_body(env->header, env->body, d);
        break;
    default:
        message_body(env->header.cls, env->header.kind, env->body, d);
        break;
    }
}

namespace {

std::vector<frf::Bytes> args_json_corpus()
{
    return {
        frf::from_text(R"({"count":3,"color":16711680})"),
        frf::from_text(R"({"on":true,"color":65280,"brightness":7})"),
        frf::from_text(R"({"gesture":"double_click"})"),
        frf::from_text(R"({"groups":[61441,2,3]})"),
        frf::from_text(R"({"ssid":"lab","pass":"pw","bssid":"a0b1c2d3e4f5","hub_host":"h"})"),
        frf::from_text(R"({"alias":"pad-1","rev":4294967295})"),
        frf::from_text(R"({"line":"info"})"),
        frf::from_text(R"({"ms":1,"bootloader":false,"value":65535,"slot":0})"),
        frf::from_text("{}"),
    };
}

}  // namespace

// JSON text -> parse_args_json -> encode_args_json for a command picked by the input's hash. Whatever it
// encodes must decode through decode_to_json, and that JSON must encode to the same bytes again.
FUZZ_TARGET(gen_args_json, "gen.args_json", args_json_corpus)
{
    struct Cmd {
        uint16_t cap;
        const fr::cap::MemberInfo *member;
    };
    static const std::vector<Cmd> cmds = [] {
        std::vector<Cmd> out;
        for (const auto &cap : fr::cap::all_caps()) {
            for (const auto &m : cap.commands) {
                out.push_back({cap.id, &m});
            }
        }
        return out;
    }();
    if (cmds.empty()) {
        return;
    }
    uint32_t h = 0x811C9DC5;
    for (const uint8_t b : data) {
        h = (h ^ b) * 0x01000193;
    }
    const Cmd &cmd = cmds[h % cmds.size()];
    d.u32(h % static_cast<uint32_t>(cmds.size()));

    cJSON *args = fr::cap::parse_args_json({reinterpret_cast<const char *>(data.data()), data.size()});
    if (args == nullptr) {
        d.u8(0xEE);
        return;
    }
    uint8_t buf[512];
    fr::wire::Writer w(buf, sizeof(buf));
    uint8_t id = 0;
    const fr::Status s = fr::cap::encode_args_json(cmd.cap, cmd.member->name, args, &id, w);
    cJSON_Delete(args);
    if (!s) {
        d.u8(static_cast<uint8_t>(s.error()));
        return;
    }
    d.ok();
    if (id != cmd.member->id) {
        frf::fail("encode_args_json returned another command id");
    }
    fold(w.bytes(), d);
    cJSON *back = fr::cap::decode_to_json(cmd.cap, fr::wire::kClsCmd, id, w.bytes());
    if (back == nullptr) {
        frf::fail("encoded arguments do not decode");
    }
    uint8_t buf2[512];
    fr::wire::Writer w2(buf2, sizeof(buf2));
    uint8_t id2 = 0;
    const fr::Status s2 = fr::cap::encode_args_json(cmd.cap, cmd.member->name, back, &id2, w2);
    cJSON_Delete(back);
    if (!s2 || !same_bytes(w.bytes(), w2.bytes())) {
        frf::fail("decoded JSON does not encode to the same arguments");
    }
}
