//! 1.47" ST7789 IPS panel (172x320, driven as 320x172 landscape) on SPI2:
//! SCK PB13 (D13), MOSI PB15 (D11), CS PB9 (D10), DC PB8 (D9), RES PB4 (D8),
//! backlight PB1 (D6).
//!
//! Draw ops paint a back buffer. `Present` copies the rows that changed into a
//! front buffer and streams them to the panel with DMA, so the panel never
//! shows a half-drawn frame and drawing never waits for SPI. Both buffers take
//! 110 KB each of the STM32U585's 768 KB of SRAM.

use core::cell::RefCell;
use core::convert::Infallible;
use core::sync::atomic::{AtomicBool, Ordering::Relaxed};

use embassy_stm32::gpio::Output;
use embassy_stm32::mode::Async;
use embassy_stm32::spi::{Spi, mode::Master};
use embassy_sync::blocking_mutex::Mutex as BlockingMutex;
use embassy_sync::blocking_mutex::raw::{CriticalSectionRawMutex, ThreadModeRawMutex};
use embassy_sync::signal::Signal;
use embassy_time::Timer;
use embedded_graphics::mono_font::iso_8859_1::{FONT_6X10, FONT_8X13, FONT_10X20};
use embedded_graphics::mono_font::{MonoFont, MonoTextStyleBuilder};
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::pixelcolor::raw::{RawData, RawU16};
use embedded_graphics::prelude::*;
use embedded_graphics::primitives::{Line, PrimitiveStyle, Rectangle};
use embedded_graphics::text::{Alignment, Baseline, Text, TextStyleBuilder};
use qonu_link_proto::{Align, DISPLAY_HEIGHT, DISPLAY_WIDTH, DrawOp, Font, rgb565};

const W: usize = DISPLAY_WIDTH as usize;
const H: usize = DISPLAY_HEIGHT as usize;
const FB_BYTES: usize = W * H * 2;
/// Landscape: MY | MV. Use 0x60 (MX | MV) to turn the picture 180 degrees.
const MADCTL: u8 = 0xA0;
/// The controller's RAM is 240x320 and this 172-pixel-wide panel starts at
/// column 34; in landscape that offset is on the row axis.
const ROW_OFFSET: u16 = 34;
/// Largest single DMA transfer is 64 KiB - 1.
const DMA_CHUNK: usize = 32 * 1024;

static mut BACK: [u8; FB_BYTES] = [0; FB_BYTES];
static mut FRONT: [u8; FB_BYTES] = [0; FB_BYTES];

static BACK_FB: BlockingMutex<ThreadModeRawMutex, RefCell<Option<Fb>>> = BlockingMutex::new(RefCell::new(None));
static WAKE: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static PRESENT: AtomicBool = AtomicBool::new(false);
static BANNER: AtomicBool = AtomicBool::new(false);
static BACKLIGHT_ON: AtomicBool = AtomicBool::new(true);
static BACKLIGHT_DIRTY: AtomicBool = AtomicBool::new(false);

/// RGB565 framebuffer, big-endian pixels (the panel's byte order), tracking the
/// rows touched since the last present.
struct Fb {
    buf: &'static mut [u8; FB_BYTES],
    dirty: Option<(usize, usize)>,
}

impl Fb {
    fn mark(&mut self, y0: usize, y1: usize) {
        self.dirty = Some(match self.dirty {
            Some((a, b)) => (a.min(y0), b.max(y1)),
            None => (y0, y1),
        });
    }
}

impl OriginDimensions for Fb {
    fn size(&self) -> Size {
        Size::new(W as u32, H as u32)
    }
}

impl DrawTarget for Fb {
    type Color = Rgb565;
    type Error = Infallible;

    fn draw_iter<I: IntoIterator<Item = Pixel<Rgb565>>>(&mut self, pixels: I) -> Result<(), Infallible> {
        for Pixel(p, c) in pixels {
            if p.x >= 0 && p.y >= 0 && (p.x as usize) < W && (p.y as usize) < H {
                let (x, y) = (p.x as usize, p.y as usize);
                let v = RawU16::from(c).into_inner();
                self.buf[(y * W + x) * 2] = (v >> 8) as u8;
                self.buf[(y * W + x) * 2 + 1] = v as u8;
                self.mark(y, y);
            }
        }
        Ok(())
    }

    fn fill_solid(&mut self, area: &Rectangle, color: Rgb565) -> Result<(), Infallible> {
        let area = area.intersection(&self.bounding_box());
        let Some(br) = area.bottom_right() else { return Ok(()) };
        let v = RawU16::from(color).into_inner();
        let (hi, lo) = ((v >> 8) as u8, v as u8);
        let (x0, y0, x1, y1) = (area.top_left.x as usize, area.top_left.y as usize, br.x as usize, br.y as usize);
        for y in y0..=y1 {
            for px in self.buf[(y * W + x0) * 2..(y * W + x1 + 1) * 2].chunks_exact_mut(2) {
                px[0] = hi;
                px[1] = lo;
            }
        }
        self.mark(y0, y1);
        Ok(())
    }
}

fn color(c: u16) -> Rgb565 {
    Rgb565::from(RawU16::new(c))
}

fn font(f: Font) -> &'static MonoFont<'static> {
    match f {
        Font::Small => &FONT_6X10,
        Font::Medium => &FONT_8X13,
        Font::Large => &FONT_10X20,
        Font::Huge => &profont::PROFONT_24_POINT,
    }
}

fn draw(fb: &mut Fb, op: &DrawOp) {
    let pt = |x: i16, y: i16| Point::new(x as i32, y as i32);
    match op {
        DrawOp::Clear { color: c } => {
            let _ = fb.clear(color(*c));
        }
        DrawOp::Rect { x, y, w, h, color: c, filled } => {
            let style = if *filled { PrimitiveStyle::with_fill(color(*c)) } else { PrimitiveStyle::with_stroke(color(*c), 1) };
            let _ = Rectangle::new(pt(*x, *y), Size::new(*w as u32, *h as u32)).into_styled(style).draw(fb);
        }
        DrawOp::Line { x0, y0, x1, y1, color: c, width } => {
            let style = PrimitiveStyle::with_stroke(color(*c), (*width).max(1) as u32);
            let _ = Line::new(pt(*x0, *y0), pt(*x1, *y1)).into_styled(style).draw(fb);
        }
        DrawOp::Text { x, y, font: f, align, color: c, bg, text } => {
            let mut style = MonoTextStyleBuilder::new().font(font(*f)).text_color(color(*c));
            if let Some(b) = bg {
                style = style.background_color(color(*b));
            }
            let alignment = match align {
                Align::Left => Alignment::Left,
                Align::Center => Alignment::Center,
                Align::Right => Alignment::Right,
            };
            let text_style = TextStyleBuilder::new().alignment(alignment).baseline(Baseline::Top).build();
            let _ = Text::with_text_style(text.as_str(), pt(*x, *y), style.build(), text_style).draw(fb);
        }
        DrawOp::Bars { x, y, h, bar_w, gap, color: c, bg, values } => {
            let (bar_w, step, h) = ((*bar_w).max(1) as i32, (*bar_w).max(1) as i32 + *gap as i32, *h as i32);
            if let Some(b) = bg {
                let size = Size::new((values.len() as i32 * step) as u32, h as u32);
                let _ = fb.fill_solid(&Rectangle::new(pt(*x, *y), size), color(*b));
            }
            for (i, v) in values.iter().enumerate() {
                let bh = ((*v).min(100) as i32 * h + 50) / 100;
                if bh > 0 {
                    let top_left = Point::new(*x as i32 + i as i32 * step, *y as i32 + h - bh);
                    let _ = fb.fill_solid(&Rectangle::new(top_left, Size::new(bar_w as u32, bh as u32)), color(*c));
                }
            }
        }
        DrawOp::Bitmap { x, y, w, h, scale, fg, bg, bits } => {
            let (w, h, k) = (*w as i32, *h as i32, (*scale).max(1) as i32);
            let stride = (w + 7) / 8;
            if let Some(b) = bg {
                let size = Size::new((w * k) as u32, (h * k) as u32);
                let _ = fb.fill_solid(&Rectangle::new(pt(*x, *y), size), color(*b));
            }
            for row in 0..h {
                // Runs of set bits as one rectangle each: a QR row is a few fills, not one per module.
                let mut col = 0;
                while col < w {
                    let set = |c: i32| bits.get((row * stride + c / 8) as usize).is_some_and(|byte| byte >> (7 - c % 8) & 1 == 1);
                    if !set(col) {
                        col += 1;
                        continue;
                    }
                    let start = col;
                    while col < w && set(col) {
                        col += 1;
                    }
                    let top_left = Point::new(*x as i32 + start * k, *y as i32 + row * k);
                    let _ = fb.fill_solid(&Rectangle::new(top_left, Size::new(((col - start) * k) as u32, k as u32)), color(*fg));
                }
            }
        }
        DrawOp::Present | DrawOp::Backlight { .. } => {}
    }
}

/// Applies one op from the host. Drawing is synchronous and cheap; showing
/// the result happens in the display task.
pub fn apply(op: &DrawOp) {
    match op {
        DrawOp::Present => PRESENT.store(true, Relaxed),
        DrawOp::Backlight { on } => {
            BACKLIGHT_ON.store(*on, Relaxed);
            BACKLIGHT_DIRTY.store(true, Relaxed);
        }
        _ => {
            BACK_FB.lock(|b| {
                if let Some(fb) = b.borrow_mut().as_mut() {
                    draw(fb, op);
                }
            });
            return;
        }
    }
    WAKE.signal(());
}

/// Shown by the MCU itself when the host stops sending heartbeats.
pub fn failsafe_banner() {
    BANNER.store(true, Relaxed);
    WAKE.signal(());
}

fn text(s: &str) -> heapless::String<{ qonu_link_proto::MAX_TEXT }> {
    heapless::String::try_from(s).unwrap_or_default()
}

fn draw_all(ops: &[DrawOp]) {
    BACK_FB.lock(|b| {
        if let Some(fb) = b.borrow_mut().as_mut() {
            for op in ops {
                draw(fb, op);
            }
        }
    });
}

fn splash() {
    let (w, h) = (W as i16, H as i16);
    draw_all(&[
        DrawOp::Clear { color: rgb565(8, 10, 16) },
        DrawOp::Text { x: w / 2, y: h / 2 - 34, font: Font::Huge, align: Align::Center, color: rgb565(90, 200, 250), bg: None, text: text("qonu") },
        DrawOp::Text { x: w / 2, y: h / 2 + 4, font: Font::Medium, align: Align::Center, color: rgb565(200, 200, 210), bg: None, text: text("Arduino UNO Q") },
        DrawOp::Text { x: w / 2, y: h / 2 + 26, font: Font::Small, align: Align::Center, color: rgb565(140, 140, 150), bg: None, text: text("STM32 up - waiting for Linux") },
    ]);
}

fn banner() {
    let w = W as i16;
    draw_all(&[
        DrawOp::Rect { x: 0, y: 56, w: W as u16, h: 60, color: rgb565(150, 20, 20), filled: true },
        DrawOp::Text { x: w / 2, y: 62, font: Font::Large, align: Align::Center, color: 0xFFFF, bg: None, text: text("LINK LOST") },
        DrawOp::Text { x: w / 2, y: 90, font: Font::Small, align: Align::Center, color: rgb565(255, 210, 210), bg: None, text: text("no heartbeat from Linux - outputs safe") },
    ]);
}

struct Panel {
    spi: Spi<'static, Async, Master>,
    cs: Output<'static>,
    dc: Output<'static>,
}

impl Panel {
    async fn cmd(&mut self, c: u8, data: &[u8]) {
        self.cs.set_low();
        self.dc.set_low();
        let _ = self.spi.write(&[c]).await;
        if !data.is_empty() {
            self.dc.set_high();
            let _ = self.spi.write(data).await;
        }
        self.cs.set_high();
    }

    async fn init(&mut self) {
        self.cmd(0x01, &[]).await; // SWRESET
        Timer::after_millis(150).await;
        self.cmd(0x11, &[]).await; // SLPOUT
        Timer::after_millis(120).await;
        self.cmd(0x3A, &[0x55]).await; // COLMOD: 16 bit/pixel
        self.cmd(0x36, &[MADCTL]).await;
        self.cmd(0x21, &[]).await; // INVON: IPS panels need inversion
        self.cmd(0x13, &[]).await; // NORON
        self.cmd(0x29, &[]).await; // DISPON
        Timer::after_millis(20).await;
    }

    /// Streams full-width rows `y0..=y1` of `front` to the panel.
    async fn flush(&mut self, front: &[u8; FB_BYTES], y0: usize, y1: usize) {
        let (xe, ys, ye) = (W as u16 - 1, y0 as u16 + ROW_OFFSET, y1 as u16 + ROW_OFFSET);
        self.cmd(0x2A, &[0, 0, (xe >> 8) as u8, xe as u8]).await; // CASET
        self.cmd(0x2B, &[(ys >> 8) as u8, ys as u8, (ye >> 8) as u8, ye as u8]).await; // RASET
        self.cs.set_low();
        self.dc.set_low();
        let _ = self.spi.write(&[0x2Cu8]).await; // RAMWR
        self.dc.set_high();
        for chunk in front[y0 * W * 2..(y1 + 1) * W * 2].chunks(DMA_CHUNK) {
            let _ = self.spi.write(chunk).await;
        }
        self.cs.set_high();
    }
}

#[embassy_executor::task]
pub async fn run(
    spi: Spi<'static, Async, Master>,
    cs: Output<'static>,
    dc: Output<'static>,
    mut reset: Output<'static>,
    mut backlight: Output<'static>,
) {
    // SAFETY: the only references to these buffers, taken once here.
    let back: &'static mut [u8; FB_BYTES] = unsafe { &mut *(&raw mut BACK) };
    let front: &'static mut [u8; FB_BYTES] = unsafe { &mut *(&raw mut FRONT) };
    BACK_FB.lock(|b| *b.borrow_mut() = Some(Fb { buf: back, dirty: None }));

    let mut panel = Panel { spi, cs, dc };
    reset.set_low();
    Timer::after_millis(10).await;
    reset.set_high();
    Timer::after_millis(120).await;
    panel.init().await;
    splash();
    PRESENT.store(true, Relaxed);

    loop {
        if BANNER.swap(false, Relaxed) {
            banner();
            PRESENT.store(true, Relaxed);
        }
        if BACKLIGHT_DIRTY.swap(false, Relaxed) {
            backlight.set_level(BACKLIGHT_ON.load(Relaxed).into());
        }
        if PRESENT.swap(false, Relaxed) {
            let rows = BACK_FB.lock(|b| {
                let mut b = b.borrow_mut();
                let fb = b.as_mut()?;
                let (y0, y1) = fb.dirty.take()?;
                front[y0 * W * 2..(y1 + 1) * W * 2].copy_from_slice(&fb.buf[y0 * W * 2..(y1 + 1) * W * 2]);
                Some((y0, y1))
            });
            if let Some((y0, y1)) = rows {
                panel.flush(front, y0, y1).await;
            }
            if BACKLIGHT_ON.load(Relaxed) {
                backlight.set_high(); // first frame is up: light the panel
            }
        }
        WAKE.wait().await;
    }
}
