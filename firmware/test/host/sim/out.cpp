// The kit's line output (design m2-c2 D2): Out's printf front end and fr_net_node's StdOut.
#include "sim/out.hpp"

#include <cstdio>

namespace frsim {

void Out::emit(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vemit(fmt, ap);
    va_end(ap);
}

void Out::vemit(const char *fmt, va_list ap)
{
    line(vsformat(fmt, ap));
}

void StdOut::line(std::string_view text)
{
    // One write per line with its newline, then flushed: the bytes fr_net_node always printed.
    std::fwrite(text.data(), 1, text.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

}  // namespace frsim
