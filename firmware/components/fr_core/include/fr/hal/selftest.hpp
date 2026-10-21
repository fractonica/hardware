// Driver self-test result (design c2 §5, decision 7), reported by diag `selftest`.
#pragma once

namespace fr::hal {

struct Selftest {
    bool ok;
    const char *detail;  // static string, never freed
};

}  // namespace fr::hal
