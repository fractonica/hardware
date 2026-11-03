// LVGL configuration of fr_ui (design m2-c5-display D5): ONE file for the board (IDF component lvgl/lvgl, pinned in
// fr_ui's idf_component.yml) and for the Mac (tools/display fetches the same release). Both builds point
// LV_CONF_PATH here and define LV_KCONFIG_IGNORE, but on IDF 6.1 that does NOT keep menuconfig out: picolibc's
// <stdint.h> includes sdkconfig.h, so the CONFIG_LV_* of LVGL's Kconfig are defined anyway, and lv_conf_internal.h
// takes CONFIG_LV_<X> for every option this file leaves unset (CONFIG_LV_STDLIB_BUILTIN even turns its
// LV_KCONFIG_PRESENT on, so unset booleans become the CONFIG value or 0 instead of LVGL's default). On the Mac the
// same options take lv_conf_internal.h's defaults. So every option the board would take from menuconfig is set here,
// to LVGL's default (the section "Set so menuconfig cannot", below): the pixels then depend only on the LVGL
// version, this file and the fonts it names. tools/display/lv-conf-check.mjs compares the effective LV_* values of a
// board build with the Mac's and names any option still taken from menuconfig; run it after an LVGL upgrade or a
// change here.
//
// Determinism (T-DISPLAY 2 compares the device's framebuffer CRC with the desktop render's): no float paths
// (LV_USE_FLOAT, LV_USE_MATRIX and vector graphics off; the widgets of D2 draw with LVGL's integer trigonometry),
// no assembly blending (LV_DRAW_SW_ASM_NONE: NEON on the Mac would round differently from the C path on Xtensa), no
// OS layer and one draw unit (rendering order is fixed), no theme transitions or "grow on press" (a snapshot right
// after a command is stable), the default theme pinned in light mode. Only the pool's size and place depend on the
// platform (64-bit pointers on the Mac; PSRAM on the board), and the pool never changes a pixel unless it runs out.
#ifndef LV_CONF_H
#define LV_CONF_H

#if !defined(__ASSEMBLY__)
#include <stdint.h>
#endif

/*====================
   Memory and stdlib
 *====================*/
// LVGL's own TLSF pool (static, internal RAM on the board) and its own string/sprintf: no libc differences.
#define LV_USE_STDLIB_MALLOC LV_STDLIB_BUILTIN
#define LV_USE_STDLIB_STRING LV_STDLIB_BUILTIN
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_BUILTIN
// Measured on the Mac (tools/display's display_lvgl_heap_worst_case: D2's worst case, 24 widgets of every kind plus
// 64 primitives of every size on top): 45 KB high-water with 64-bit pointers, all of it objects (no draw layer: none
// of D2's widgets needs one; drawing took under 1 KB more). The board's 32-bit objects take about 0.72 of that
// (sizeof lv_obj_t 56 vs 80, lv_label_t 112 vs 144), about 33 KB, and its log reports the high-water after each
// layout (T-DISPLAY 7). 64 KB on a board with PSRAM (where the pool lives, fr_ui_pool.h); 48 KB of internal RAM on a
// board without (design scale-round-c1 D4: 32 KB held only the layout and 14 of the 64 primitives on the Mac; 48 KB
// holds the worst case on the board with fr_ui's 5 KB reserve to spare, and leaves the C6 about 44 KB of internal
// heap; 64 KB beside Wi-Fi would not fit). However full the pool, fr_ui refuses or skips what does not fit rather
// than let LVGL fail an allocation (fr/ui/lvgl_backend.hpp). The Mac gets 128 KB for its wider pointers.
#if defined(ESP_PLATFORM) && !defined(__ASSEMBLY__)
#include "sdkconfig.h"
#endif
#if defined(FR_LV_MEM_SIZE)
// A Mac build that tries a board's pool (tools/display: FR_DISPLAY_LV_MEM_SIZE=32768 node tools/display-build.mjs).
#define LV_MEM_SIZE (FR_LV_MEM_SIZE)
#elif defined(UINTPTR_MAX) && UINTPTR_MAX > 0xFFFFFFFFu
#define LV_MEM_SIZE (128U * 1024U)
#elif defined(ESP_PLATFORM) && !defined(CONFIG_SPIRAM)
#define LV_MEM_SIZE (48U * 1024U)
#else
#define LV_MEM_SIZE (64U * 1024U)
#endif
#define LV_MEM_ADR 0
// The board allocates the pool at lv_init, in PSRAM when it has some (fr_ui_pool.h): a static 64 KB would fill the S3's
// internal RAM.
#if defined(ESP_PLATFORM)
#define LV_MEM_POOL_INCLUDE "fr_ui_pool.h"
#define LV_MEM_POOL_ALLOC fr_ui_pool_alloc
#endif
#define LV_MEM_POOL_EXPAND_SIZE 0

/*====================
   OS, timing, display
 *====================*/
// The board runs LVGL from one task of fr_ui's own (src/esp/runtime.cpp); the Mac runs it synchronously.
#define LV_USE_OS LV_OS_NONE
#define LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565
// The refresh timer's period; fr_ui sets it to the instance's flush_ms at init.
#define LV_DEF_REFR_PERIOD 20
#define LV_DPI_DEF 130
#define LV_DRAW_BUF_STRIDE_ALIGN 1
#define LV_DRAW_BUF_ALIGN 4
#define LV_USE_MATRIX 0
#define LV_USE_FLOAT 0
#define LV_USE_VECTOR_GRAPHIC 0
#define LV_USE_SNAPSHOT 0
#define LV_USE_THORVG 0
#define LV_DRAW_LAYER_SIMPLE_BUF_SIZE (24U * 1024U)
#define LV_DRAW_LAYER_MAX_MEMORY 0

/*====================
   Software renderer
 *====================*/
#define LV_USE_DRAW_SW 1
#define LV_DRAW_SW_SUPPORT_RGB565 1
#define LV_DRAW_SW_SUPPORT_RGB565_SWAPPED 0
#define LV_DRAW_SW_SUPPORT_RGB565A8 1
#define LV_DRAW_SW_SUPPORT_RGB888 0
#define LV_DRAW_SW_SUPPORT_XRGB8888 0
#define LV_DRAW_SW_SUPPORT_ARGB8888 1
#define LV_DRAW_SW_SUPPORT_ARGB8888_PREMULTIPLIED 0
#define LV_DRAW_SW_SUPPORT_L8 0
#define LV_DRAW_SW_SUPPORT_AL88 0
#define LV_DRAW_SW_SUPPORT_A8 1
#define LV_DRAW_SW_SUPPORT_I1 0
#define LV_DRAW_SW_COMPLEX 1
#define LV_USE_DRAW_SW_COMPLEX_GRADIENTS 0
#define LV_DRAW_SW_SHADOW_CACHE_SIZE 0
#define LV_DRAW_SW_CIRCLE_CACHE_SIZE 4
#define LV_USE_DRAW_SW_ASM LV_DRAW_SW_ASM_NONE
#define LV_USE_NATIVE_HELIUM_ASM 0
#define LV_USE_DRAW_ARM2D_SYNC 0
#define LV_USE_PPA 0

/*====================
   Input
 *====================*/
#define LV_INDEV_DEF_SCROLL_LIMIT 10
#define LV_INDEV_DEF_SCROLL_THROW 10
#define LV_INDEV_DEF_LONG_PRESS_TIME 400
#define LV_INDEV_DEF_LONG_PRESS_REP_TIME 100
#define LV_INDEV_DEF_GESTURE_LIMIT 50
#define LV_INDEV_DEF_GESTURE_MIN_VELOCITY 3
#define LV_USE_GESTURE_RECOGNITION 0

/*====================
   Features
 *====================*/
#define LV_USE_OBJ_ID 0
#define LV_USE_OBJ_NAME 0
#define LV_USE_OBJ_PROPERTY 0
#define LV_USE_OBSERVER 0
#define LV_USE_TRANSLATION 0
#define LV_USE_COLOR_FILTER 0
#define LV_USE_LOG 0
#define LV_USE_ASSERT_NULL 0
#define LV_USE_ASSERT_MALLOC 0
#define LV_USE_ASSERT_STYLE 0
#define LV_USE_ASSERT_MEM_INTEGRITY 0
#define LV_USE_ASSERT_OBJ 0
#define LV_USE_CHECK_ARG 1
#define LV_CHECK_ARG_ASSERT_ON_FAIL 0
#define LV_CHECK_ARG_LOG_MODE LV_CHECK_ARG_LOG_MODE_NONE
#define LV_USE_SYSMON 0
#define LV_USE_PERF_MONITOR 0
#define LV_USE_MEM_MONITOR 0
#define LV_USE_PROFILER 0
#define LV_BIG_ENDIAN_SYSTEM 0
#define LV_CACHE_DEF_SIZE 0
#define LV_IMAGE_HEADER_CACHE_DEF_CNT 0
#define LV_USE_FS_STDIO 0
#define LV_USE_FS_POSIX 0
#define LV_USE_FS_MEMFS 0

/*====================
   Themes and layouts
 *====================*/
// The default theme, light, pinned again at init (fr_ui src/engine.cpp: blue primary, red secondary): no
// transitions (a snapshot right after a command must not catch a fade) and no grow-on-press transform.
#define LV_USE_THEME_DEFAULT 1
#define LV_THEME_DEFAULT_DARK 0
#define LV_THEME_DEFAULT_GROW 0
#define LV_THEME_DEFAULT_TRANSITION_TIME 0
#define LV_USE_THEME_SIMPLE 0
#define LV_USE_THEME_MONO 0
#define LV_USE_FLEX 0
#define LV_USE_GRID 0

/*====================
   Text and fonts
 *====================*/
// The built-in Montserrat sizes of D2 only: 14 (font 0, text size 1), 20 (1, 2), 28 (2, 3 and 4).
#define LV_FONT_MONTSERRAT_8 0
#define LV_FONT_MONTSERRAT_10 0
#define LV_FONT_MONTSERRAT_12 0
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 0
#define LV_FONT_MONTSERRAT_18 0
#define LV_FONT_MONTSERRAT_20 1
#define LV_FONT_MONTSERRAT_22 0
#define LV_FONT_MONTSERRAT_24 0
#define LV_FONT_MONTSERRAT_26 0
#define LV_FONT_MONTSERRAT_28 1
#define LV_FONT_MONTSERRAT_30 0
#define LV_FONT_MONTSERRAT_32 0
#define LV_FONT_MONTSERRAT_34 0
#define LV_FONT_MONTSERRAT_36 0
#define LV_FONT_MONTSERRAT_38 0
#define LV_FONT_MONTSERRAT_40 0
#define LV_FONT_MONTSERRAT_42 0
#define LV_FONT_MONTSERRAT_44 0
#define LV_FONT_MONTSERRAT_46 0
#define LV_FONT_MONTSERRAT_48 0
#define LV_FONT_MONTSERRAT_28_COMPRESSED 0
#define LV_FONT_DEJAVU_16_PERSIAN_HEBREW 0
#define LV_FONT_SOURCE_HAN_SANS_SC_14_CJK 0
#define LV_FONT_SOURCE_HAN_SANS_SC_16_CJK 0
#define LV_FONT_UNSCII_8 0
#define LV_FONT_UNSCII_16 0
#define LV_FONT_DEFAULT &lv_font_montserrat_14
#define LV_FONT_FMT_TXT_LARGE 0
#define LV_USE_FONT_COMPRESSED 0
#define LV_USE_FONT_PLACEHOLDER 1
#define LV_USE_FONT_MANAGER 0
#define LV_USE_IMGFONT 0
#define LV_USE_FREETYPE 0
#define LV_USE_TINY_TTF 0
#define LV_TXT_ENC LV_TXT_ENC_UTF8
#define LV_TXT_LINE_BREAK_LONG_LEN 0
#define LV_USE_BIDI 0
#define LV_USE_ARABIC_PERSIAN_CHARS 0

/*====================
   Widgets
 *====================*/
// D2's kinds: label, button, bar, slider, arc, switch, rect (a plain lv_obj). Nothing else.
#define LV_WIDGETS_HAS_DEFAULT_VALUE 0
#define LV_USE_ANIMIMG 0
#define LV_USE_ARC 1
#define LV_USE_ARCLABEL 0
#define LV_USE_BAR 1
#define LV_USE_BARCODE 0
#define LV_USE_BUTTON 1
#define LV_USE_BUTTONMATRIX 0
#define LV_USE_CALENDAR 0
#define LV_USE_CANVAS 0
#define LV_USE_CHART 0
#define LV_USE_CHECKBOX 0
#define LV_USE_DROPDOWN 0
#define LV_USE_GIF 0
#define LV_USE_IMAGE 0
#define LV_USE_IMAGEBUTTON 0
#define LV_USE_IME_PINYIN 0
#define LV_USE_KEYBOARD 0
#define LV_USE_LABEL 1
#define LV_LABEL_TEXT_SELECTION 0
#define LV_LABEL_LONG_TXT_HINT 1
#define LV_USE_LED 0
#define LV_USE_LINE 0
#define LV_USE_LIST 0
#define LV_USE_LOTTIE 0
#define LV_USE_MENU 0
#define LV_USE_MSGBOX 0
#define LV_USE_QRCODE 0
#define LV_USE_RLOTTIE 0
#define LV_USE_ROLLER 0
#define LV_USE_SCALE 0
#define LV_USE_SLIDER 1
#define LV_USE_SPAN 0
#define LV_USE_SPINBOX 0
#define LV_USE_SPINNER 0
#define LV_USE_SWITCH 1
#define LV_USE_TABLE 0
#define LV_USE_TABVIEW 0
#define LV_USE_TEXTAREA 0
#define LV_USE_TILEVIEW 0
#define LV_USE_WIN 0
#define LV_USE_3DTEXTURE 0

/*====================
   Image decoders, drivers, others
 *====================*/
#define LV_USE_LODEPNG 0
#define LV_USE_LIBPNG 0
#define LV_USE_BMP 0
#define LV_USE_TJPGD 0
#define LV_USE_LIBJPEG_TURBO 0
#define LV_USE_LIBWEBP 0
#define LV_USE_SVG 0
#define LV_USE_RLE 0
#define LV_USE_LZ4 0
#define LV_USE_FFMPEG 0
#define LV_USE_SDL 0
#define LV_USE_X11 0
#define LV_USE_LINUX_FBDEV 0
#define LV_USE_LINUX_DRM 0
#define LV_USE_ST7789 0
#define LV_USE_GENERIC_MIPI 0
#define LV_USE_ILI9341 0
#define LV_USE_GRIDNAV 0
#define LV_USE_FRAGMENT 0
#define LV_USE_IMGFONT 0
#define LV_USE_XML 0
#define LV_USE_TEST 0

#define LV_BUILD_EXAMPLES 0
#define LV_BUILD_DEMOS 0

/*====================
   Set so menuconfig cannot
 *====================*/
// Options lv_conf_internal.h would take from the board's CONFIG_LV_* (see the top): LVGL 9.6's defaults, as the Mac
// takes them. Most equal menuconfig's defaults today; the calendar header arrow and dropdown do not (Kconfig: on).
#define LV_COLOR_DEPTH 16
#define LV_COLOR_MIX_ROUND_OFS 0
#define LV_GRADIENT_MAX_STOPS 2
#define LV_DRAW_SW_I1_LUM_THRESHOLD 127
#define LV_OBJ_STYLE_CACHE 1
#define LV_INDEV_DEF_SCROLL_ELASTIC_FACTOR 4
#define LV_INDEV_DEF_DOUBLE_CLICK_TIME 400
#define LV_INDEV_DEF_ROTARY_SENSITIVITY 256
#define LV_TXT_BREAK_CHARS " ,.;:-_)]}"
#define LV_TXT_COLOR_CMD "#"
#define LV_LABEL_WAIT_CHAR_COUNT 3
#define LV_SPAN_SNIPPET_STACK_SIZE 64
#define LV_TEXTAREA_DEF_PWD_SHOW_TIME 1500
#define LV_FS_DEFAULT_DRIVER_LETTER 0
#define LV_STDINT_INCLUDE "stdint.h"
#define LV_STDDEF_INCLUDE "stddef.h"
#define LV_STDBOOL_INCLUDE "stdbool.h"
#define LV_INTTYPES_INCLUDE "inttypes.h"
#define LV_LIMITS_INCLUDE "limits.h"
#define LV_STDARG_INCLUDE "stdarg.h"
// The calendar (not built: LV_USE_CALENDAR 0) still reads these (and, from the names being set, LVGL derives
// LV_CALENDAR_DISABLE_DEFAULT_*_NAMES 1 on both builds).
#define LV_USE_CALENDAR_HEADER_ARROW 0
#define LV_USE_CALENDAR_HEADER_DROPDOWN 0
#define LV_MONDAY_STR "Mo"
#define LV_TUESDAY_STR "Tu"
#define LV_WEDNESDAY_STR "We"
#define LV_THURSDAY_STR "Th"
#define LV_FRIDAY_STR "Fr"
#define LV_SATURDAY_STR "Sa"
#define LV_SUNDAY_STR "Su"
#define LV_JANUARY_STR "January"
#define LV_FEBRUARY_STR "February"
#define LV_MARCH_STR "March"
#define LV_APRIL_STR "April"
#define LV_MAY_STR "May"
#define LV_JUNE_STR "June"
#define LV_JULY_STR "July"
#define LV_AUGUST_STR "August"
#define LV_SEPTEMBER_STR "September"
#define LV_OCTOBER_STR "October"
#define LV_NOVEMBER_STR "November"
#define LV_DECEMBER_STR "December"

#endif /*LV_CONF_H*/
