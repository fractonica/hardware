// Golden vectors (T-CODEC, design c2 §8): every case in gen/vectors.inc (generated from schema/vectors)
// encodes to exactly its bytes and decodes back to an equal value (decode-only cases just decode, error
// cases fail with their DecodeErr), through the generated codecs and the hand-written envelope and
// serial-line runtime. A decoded capability struct is valid() unless the case is `*.lenient_*`, as the
// TS JSON accessors accept exactly the non-lenient cases. The TS suite checks the same vectors.
#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

#include "fr/envelope.hpp"
#include "fr/serial_line.hpp"
#include "tests/test.hpp"
#include "vectors.inc"

namespace {

using fr::wire::Writer;

struct Checker {
    size_t count = 0;
    const char *current = "";

    // A failed check prints the vector it belongs to.
    bool ok(bool passed)
    {
        if (!passed) {
            std::printf("    in vector %s\n", current);
        }
        return passed;
    }

    template <class T, class Enc, class Dec>
    void value(const char *name, const char *type, const T &x, Enc enc, Dec dec, std::string_view hex, bool encode)
    {
        ++count;
        current = name;
        static_cast<void>(type);
        const auto want = frt::from_hex(hex);
        uint8_t buf[2048];
        Writer w(buf, sizeof(buf));
        const size_t n = enc(x, w);
        if (encode) {
            ok(CHECK(!w.overflow()) && CHECK_EQ(n, w.size()) && CHECK_BYTES(w.bytes(), want));
        }
        if constexpr (requires { T::kMaxSize; }) {
            ok(CHECK(n <= T::kMaxSize));
        }
        const auto got = dec(std::span<const uint8_t>(want));
        if (ok(CHECK(got.has_value()))) {
            ok(CHECK(*got == x));
            // Capability structs only (system messages and STATE values have no valid()).
            if constexpr (requires { valid(x); }) {
                const bool lenient = std::string_view(name).find(".lenient_") != std::string_view::npos;
                ok(CHECK_EQ(valid(*got), !lenient));
            }
        }
    }

    template <class Dec>
    void error(const char *name, const char *type, Dec dec, std::string_view hex, fr::wire::DecodeErr err)
    {
        ++count;
        current = name;
        static_cast<void>(type);
        const auto in = frt::from_hex(hex);
        const auto got = dec(std::span<const uint8_t>(in));
        if (ok(CHECK(!got.has_value()))) {
            ok(CHECK_EQ(fr::wire::decode_err_name(got.error()), fr::wire::decode_err_name(err)));
        }
    }

    void header(const char *name, const fr::wire::Header &h, std::string_view hex)
    {
        ++count;
        current = name;
        const auto want = frt::from_hex(hex);
        uint8_t buf[fr::wire::kMaxHeaderSize];
        Writer w(buf, sizeof(buf));
        fr::wire::pack_header(h, w);
        ok(CHECK_BYTES(w.bytes(), want));
        const auto got = fr::wire::unpack_header(want);
        if (ok(CHECK(got.has_value()))) {
            ok(CHECK(*got == h));
        }
    }

    void envelope(const char *name, const fr::wire::Header &h, fr::wire::PrefixType prefix, uint32_t t_us,
                  const fr::wire::ResultPrefix &rp, std::span<const uint8_t> body, std::string_view hex)
    {
        ++count;
        current = name;
        const auto want = frt::from_hex(hex);
        uint8_t buf[2048];
        Writer w(buf, sizeof(buf));
        fr::wire::pack_header(h, w);
        if (prefix == fr::wire::PrefixType::time) {
            fr::wire::pack_time_prefix(t_us, w);
        } else if (prefix == fr::wire::PrefixType::result) {
            fr::wire::pack_result_prefix(rp, w);
        }
        w.raw(body);
        ok(CHECK_BYTES(w.bytes(), want));
        const auto got = fr::wire::unpack_envelope(want);
        if (!ok(CHECK(got.has_value()))) {
            return;
        }
        ok(CHECK(got->header == h));
        ok(CHECK(fr::wire::prefix_type(h.cls) == prefix));
        if (prefix == fr::wire::PrefixType::time) {
            ok(CHECK_EQ(got->t_us, t_us));
        } else if (prefix == fr::wire::PrefixType::result) {
            ok(CHECK(got->result == rp));
        }
        ok(CHECK_BYTES(got->body, body));
    }

    void serial(const char *name, uint8_t type, std::span<const uint8_t> body, std::string_view line, std::string_view input, bool encode)
    {
        ++count;
        current = name;
        if (encode) {
            char out[fr::wire::kMaxLine];
            const size_t n = fr::wire::encode_line(type, body, out);
            ok(CHECK_EQ(std::string_view(out, n), line));
        }
        uint8_t scratch[fr::wire::kMaxLineFrame];
        const auto got = fr::wire::decode_line(input, scratch);
        if (ok(CHECK(got.has_value()))) {
            ok(CHECK_EQ(got->type, type));
            ok(CHECK_BYTES(got->body, body));
        }
    }
};

}  // namespace

TEST(golden_vectors_encode_and_decode)
{
    Checker c;
    fr_vectors::for_each(c);
    CHECK_EQ(c.count, fr_vectors::kCount);
    CHECK(c.count > 0);
}
