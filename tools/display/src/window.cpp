// See window.hpp. Built with SDL2 when CMake finds Homebrew's (pkg-config sdl2), else a clear error.
#include "window.hpp"

#include "png.hpp"

#include <cJSON.h>
#include <cstdio>
#include <vector>

#if FR_DISPLAY_SDL
#include <SDL.h>
#endif

namespace frd {

#if FR_DISPLAY_SDL

namespace {

void print_events(const Session &s, size_t &printed)
{
    for (; printed < s.events().size(); ++printed) {
        const UiEvent &e = s.events()[printed];
        cJSON *o = cJSON_CreateObject();
        cJSON *j = cJSON_AddObjectToObject(o, "event");
        cJSON_AddStringToObject(j, "id", e.id.c_str());
        cJSON_AddStringToObject(j, "kind", kind_name(e.kind));
        cJSON_AddNumberToObject(j, "value", e.value);
        char *text = cJSON_PrintUnformatted(o);
        std::printf("%s\n", text);
        std::fflush(stdout);
        cJSON_free(text);
        cJSON_Delete(o);
    }
}

/** The glass as RGB565 pixels (a mono panel lit white on black; a round panel's corners dim grey). */
void to_rgb565(Session &s, std::vector<uint16_t> &px)
{
    const Geometry &g = s.geometry();
    const auto glass = s.panel().glass();
    px.resize(static_cast<size_t>(g.width) * g.height);
    if (g.format == fr::hal::PixelFormat::rgb565) {
        for (size_t i = 0; i < px.size(); ++i) {
            px[i] = static_cast<uint16_t>(glass[i * 2] | (glass[i * 2 + 1] << 8));
        }
        if (g.round) {
            for (size_t i = 0; i < px.size(); ++i) {
                if (!on_round_glass(static_cast<uint32_t>(i % g.width), static_cast<uint32_t>(i / g.width), g.width,
                                    g.height)) {
                    px[i] = kOutsideGlass;
                }
            }
        }
        return;
    }
    const size_t stride = (g.width + 7u) / 8u;
    for (size_t y = 0; y < g.height; ++y) {
        for (size_t x = 0; x < g.width; ++x) {
            const bool on = (glass[y * stride + x / 8] >> (7 - x % 8)) & 1;
            px[y * g.width + x] = on ? 0xFFFF : 0x0000;
        }
    }
}

}  // namespace

int run_window(Session &s, int scale, std::string &why)
{
    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        why = std::string("SDL cannot start: ") + SDL_GetError();
        return 1;
    }
    const Geometry &g = s.geometry();
    SDL_Window *win = SDL_CreateWindow("fr display", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, g.width * scale,
                                       g.height * scale, 0);
    SDL_Renderer *ren = win != nullptr ? SDL_CreateRenderer(win, -1, 0) : nullptr;
    SDL_Texture *tex = ren != nullptr ? SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGB565, SDL_TEXTUREACCESS_STREAMING,
                                                          g.width, g.height)
                                      : nullptr;
    if (tex == nullptr) {
        why = std::string("SDL cannot open a window: ") + SDL_GetError();
        SDL_Quit();
        return 1;
    }
    std::vector<uint16_t> px;
    size_t printed = s.events().size();
    bool down = false;
    for (bool run = true; run;) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev) != 0) {
            const auto at = [&](int x, int y) {
                const int px_x = x / scale < 0 ? 0 : (x / scale >= g.width ? g.width - 1 : x / scale);
                const int px_y = y / scale < 0 ? 0 : (y / scale >= g.height ? g.height - 1 : y / scale);
                return std::pair<uint16_t, uint16_t>(static_cast<uint16_t>(px_x), static_cast<uint16_t>(px_y));
            };
            if (ev.type == SDL_QUIT || (ev.type == SDL_KEYDOWN && ev.key.keysym.sym == SDLK_ESCAPE)) {
                run = false;
            } else if (ev.type == SDL_MOUSEBUTTONDOWN && ev.button.button == SDL_BUTTON_LEFT) {
                down = true;
                const auto [x, y] = at(ev.button.x, ev.button.y);
                s.touch(x, y, true);
            } else if (ev.type == SDL_MOUSEMOTION && down) {
                const auto [x, y] = at(ev.motion.x, ev.motion.y);
                s.touch(x, y, true);
            } else if (ev.type == SDL_MOUSEBUTTONUP && ev.button.button == SDL_BUTTON_LEFT && down) {
                down = false;
                const auto [x, y] = at(ev.button.x, ev.button.y);
                s.touch(x, y, false);
            }
        }
        s.advance(16);
        print_events(s, printed);
        to_rgb565(s, px);
        SDL_UpdateTexture(tex, nullptr, px.data(), g.width * 2);
        SDL_RenderClear(ren);
        SDL_RenderCopy(ren, tex, nullptr, nullptr);
        SDL_RenderPresent(ren);
        SDL_Delay(16);
    }
    if (down) {
        s.touch(0, 0, false);
    }
    SDL_DestroyTexture(tex);
    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}

#else

int run_window(Session &s, int scale, std::string &why)
{
    static_cast<void>(s);
    static_cast<void>(scale);
    why = "this fr_display_render was built without SDL2: install it (brew install sdl2) and rebuild "
          "(node tools/display-build.mjs)";
    return 1;
}

#endif

}  // namespace frd
