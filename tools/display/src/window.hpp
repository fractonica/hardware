// fr_display_render --window (design m2-c5-display D6): the panel in an SDL2 window, the mouse as the finger.
#pragma once

#include <string>

#include "session.hpp"

namespace frd {

/**
 * Shows the panel's glass at `scale` until the window closes (or Esc), feeding mouse presses, drags and releases to
 * the session as raw touches and printing each new ui event as a {"event": {...}} line. 0, or non-zero with `why`
 * when there is no window to open (built without SDL2, or SDL cannot start).
 */
int run_window(Session &s, int scale, std::string &why);

}  // namespace frd
