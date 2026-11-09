//! qonu link protocol: Linux on the QRB2210 <-> the STM32U585, over the UART
//! that joins them (Linux `/dev/ttyHS1`, MCU LPUART1).
//!
//! One frame on the wire:
//!
//! ```text
//!     COBS( seq: u16 LE ‖ postcard(body) ‖ crc32: u32 LE ) ‖ 0x00
//! ```
//!
//! The CRC (CRC-32/ISO-HDLC) covers `seq` and the body. COBS removes every
//! 0x00 from the payload, so 0x00 only ever marks a frame boundary: after a
//! dropped or corrupted byte the receiver resynchronises at the next boundary
//! and loses at most the damaged frame. Requests carry a `seq` chosen by the
//! host; the MCU answers with the same `seq`. `seq` sits outside the postcard
//! body so an MCU can still answer `BadRequest` to a message it cannot parse
//! (for example a newer host using a request variant it doesn't know).
#![cfg_attr(not(test), no_std)]

use serde::{Deserialize, Serialize, de::DeserializeOwned};

/// Bumped on incompatible changes. New enum variants appended at the end are
/// compatible: an older peer answers them with `ErrorCode::BadRequest`.
pub const PROTO_VERSION: u16 = 4;

/// Largest `seq ‖ body ‖ crc` before COBS.
pub const MAX_RAW: usize = 250;
/// Largest encoded frame, including the 0x00 delimiter.
pub const MAX_FRAME: usize = MAX_RAW + MAX_RAW / 254 + 2;

const CRC32: crc::Crc<u32> = crc::Crc::<u32>::new(&crc::CRC_32_ISO_HDLC);

// ---------------------------------------------------------------- messages

/// Linux -> MCU.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// Round trip; the MCU echoes `nonce`.
    Ping { nonce: u32 },
    /// Firmware identity, uptime, reset cause and link counters.
    GetInfo,
    /// Arms or refreshes the failsafe. If the next heartbeat doesn't arrive
    /// within `ttl_ms`, the MCU latches its safe state. `ttl_ms = 0` disarms.
    Heartbeat { ttl_ms: u16 },
    /// Leaves the latched safe state. The host sends it once it is healthy.
    ClearFailsafe,
    /// RGB user LED. `led` 0 is LED3, owned by the host; LED4 shows link state.
    SetLed { led: u8, r: bool, g: bool, b: bool },
    /// Deliberately breaks the firmware to prove recovery works. No response:
    /// the MCU resets (watchdog or panic) and reports it in `Event::Boot`.
    Fault { kind: Fault },
    /// Shows a frame on the 13x8 LED matrix: one row per element, top first;
    /// bit `x` lights column `x` (0 = left). Bits above 12 are ignored.
    Matrix { rows: [u16; MATRIX_HEIGHT] },
    /// Drawing on the SPI display. Ops paint an off-screen buffer in order;
    /// `DrawOp::Present` shows it. Hosts split long op lists across frames.
    Draw { ops: heapless::Vec<DrawOp, MAX_DRAW_OPS> },
    /// The LED&KEY module (protocol v4): a TM1638 driving 8 seven-segment digits and 8 LEDs, on header D12 (STB),
    /// D7 (CLK) and D5 (DIO). `digits` are segment bits, left digit first: bit 0 = a (top) .. bit 6 = g (middle),
    /// bit 7 = the decimal point. `leds` bit `i` lights LED `i + 1`. `level` 0 turns the module off, 1-8 is the
    /// brightness. The MCU keeps it and repaints it every second, so a module plugged in later shows it too.
    Panel { digits: [u8; PANEL_DIGITS], leds: u8, level: u8 },
    /// Whether the LED&KEY module answers (protocol v4): `Response::Panel`.
    PanelStatus,
}

pub const PANEL_DIGITS: usize = 8;
/// `Event::Button` ids of the LED&KEY module's keys: S1 is `PANEL_KEY_FIRST`, S8 is `PANEL_KEY_FIRST + 7`.
pub const PANEL_KEY_FIRST: u8 = 8;

/// Display geometry, landscape, origin top left.
pub const DISPLAY_WIDTH: u16 = 320;
pub const DISPLAY_HEIGHT: u16 = 172;
pub const MAX_DRAW_OPS: usize = 24;
pub const MAX_TEXT: usize = 64;
pub const MAX_BARS: usize = 96;
/// Bitmap bytes in one op: up to 40 x 40 pixels (a version 5 QR code, 37 x 37, takes 185).
pub const MAX_BITMAP: usize = 200;

/// One drawing operation. Colors are RGB565. Coordinates may run off-screen;
/// drawing is clipped.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DrawOp {
    /// Fill the whole buffer.
    Clear { color: u16 },
    Rect { x: i16, y: i16, w: u16, h: u16, color: u16, filled: bool },
    Line { x0: i16, y0: i16, x1: i16, y1: i16, color: u16, width: u8 },
    /// Text with its top edge at `y`; `x` is the left, center or right edge
    /// per `align`. With `bg`, glyph cells are painted (erasing what was there).
    Text {
        x: i16,
        y: i16,
        font: Font,
        align: Align,
        color: u16,
        bg: Option<u16>,
        text: heapless::String<MAX_TEXT>,
    },
    /// Bar graph in the box `(x, y, w = len * (bar_w + gap), h)`: one bar per
    /// value (0-100, % of `h`), bottom aligned. With `bg`, the box is cleared first.
    Bars {
        x: i16,
        y: i16,
        h: u16,
        bar_w: u8,
        gap: u8,
        color: u16,
        bg: Option<u16>,
        values: heapless::Vec<u8, MAX_BARS>,
    },
    /// Show what has been drawn so far.
    Present,
    Backlight { on: bool },
    /// A 1-bit image (protocol v3), `w` x `h` pixels, each drawn as a `scale` x `scale` square: set bits in `fg`,
    /// clear ones in `bg` (left out: transparent). Rows are packed MSB first, each row starting on a byte. A QR code
    /// (version 4, 33 x 33) is 165 bytes: one op.
    Bitmap {
        x: i16,
        y: i16,
        w: u8,
        h: u8,
        scale: u8,
        fg: u16,
        bg: Option<u16>,
        bits: heapless::Vec<u8, MAX_BITMAP>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Font {
    /// 6x10 px cells
    Small,
    /// 8x13
    Medium,
    /// 10x20
    Large,
    /// ProFont 24 pt (16x29 px cells), for big numbers
    Huge,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

/// 8-bit-per-channel color to RGB565.
pub const fn rgb565(r: u8, g: u8, b: u8) -> u16 {
    ((r as u16 & 0xF8) << 8) | ((g as u16 & 0xFC) << 3) | (b as u16 >> 3)
}

pub const MATRIX_WIDTH: usize = 13;
pub const MATRIX_HEIGHT: usize = 8;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// Spin forever inside the link task; the independent watchdog must reset.
    Hang,
    /// `panic!()`; the panic handler records the line and resets.
    Panic,
}

/// MCU -> Linux: the answer to the request with the same `seq`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Response {
    Pong { nonce: u32, uptime_ms: u32 },
    Info(Info),
    Ok,
    Error(ErrorCode),
    /// The answer to `Request::PanelStatus` (protocol v4).
    Panel { present: bool },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub proto: u16,
    /// Firmware version, semver.
    pub fw: [u8; 3],
    pub uptime_ms: u32,
    pub reset_cause: ResetCause,
    /// STM32 96-bit unique device ID.
    pub uid: [u8; 12],
    pub failsafe: FailsafeState,
    pub link: LinkCounters,
    /// Where the panic that caused the last reset happened, if one did.
    pub last_panic: Option<PanicSite>,
}

/// A panic location recorded across the reset it caused.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct PanicSite {
    /// The last bytes of the source path, NUL-padded.
    pub file_tail: [u8; PANIC_FILE_TAIL],
    pub line: u32,
    pub column: u32,
}

pub const PANIC_FILE_TAIL: usize = 28;

impl PanicSite {
    pub fn new(file: &str, line: u32, column: u32) -> Self {
        let b = file.as_bytes();
        let tail = &b[b.len().saturating_sub(PANIC_FILE_TAIL)..];
        let mut file_tail = [0; PANIC_FILE_TAIL];
        file_tail[..tail.len()].copy_from_slice(tail);
        Self { file_tail, line, column }
    }

    pub fn file(&self) -> &str {
        let end = self.file_tail.iter().position(|&c| c == 0).unwrap_or(PANIC_FILE_TAIL);
        // A cut may land inside a multi-byte character; keep the valid part.
        match core::str::from_utf8(&self.file_tail[..end]) {
            Ok(s) => s,
            Err(e) => core::str::from_utf8(&self.file_tail[e.valid_up_to()..end]).unwrap_or(""),
        }
    }
}

/// Receive-side counters, kept by each end for its own direction.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LinkCounters {
    pub frames: u32,
    pub bad_crc: u32,
    /// COBS errors, frames too short or too long, undecodable bodies.
    pub bad_frame: u32,
    /// UART overruns, framing or noise errors reported by the hardware.
    pub uart_errors: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetCause {
    PowerOn,
    Pin,
    Software,
    IndependentWatchdog,
    WindowWatchdog,
    LowPower,
    BrownOut,
    OptionBytes,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailsafeState {
    Disarmed,
    Armed,
    /// Heartbeat lost; outputs are in their safe state until `ClearFailsafe`.
    Tripped,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// The frame was intact but the body didn't parse (unknown request).
    BadRequest,
    InvalidArgument,
    /// Refused because the failsafe is tripped.
    FailsafeTripped,
}

/// Unsolicited MCU -> Linux messages. Their `seq` is the MCU's event counter.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// First frame after every MCU reset.
    Boot { reset_cause: ResetCause },
    Failsafe { state: FailsafeState },
    /// A front-panel button changed (protocol v3), debounced on the MCU. Buttons go to GND with the internal pull-up:
    /// `id` 0 confirm on header D2 (PB3), 1 up on D3 (PB0), 2 down on D4 (PA12). `t_ms` is the MCU's uptime at the
    /// edge, so Linux can tell press lengths apart whatever the link adds.
    Button { id: u8, pressed: bool, t_ms: u32 },
    /// The LED&KEY module answered, or stopped answering (protocol v4). Its keys S1..S8 are `Button` ids 8..15.
    Panel { present: bool },
}

/// Body of every MCU -> Linux frame.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Up {
    Response(Response),
    Event(Event),
}

// ----------------------------------------------------------------- framing

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// Encoded body doesn't fit in `MAX_RAW`.
    TooLong,
    /// Malformed COBS.
    Cobs,
    /// Shorter than seq + crc.
    Short,
    BadCrc,
    /// Intact frame whose body didn't parse as the expected type.
    Decode,
}

/// Encodes one frame, delimiter included, into `out`. Returns its length.
pub fn encode<T: Serialize>(seq: u16, body: &T, out: &mut [u8; MAX_FRAME]) -> Result<usize, FrameError> {
    let mut raw = [0u8; MAX_RAW];
    raw[..2].copy_from_slice(&seq.to_le_bytes());
    let n = postcard::to_slice(body, &mut raw[2..MAX_RAW - 4])
        .map_err(|_| FrameError::TooLong)?
        .len();
    let crc = CRC32.checksum(&raw[..2 + n]);
    raw[2 + n..6 + n].copy_from_slice(&crc.to_le_bytes());
    let len = cobs_encode(&raw[..6 + n], &mut out[..MAX_FRAME - 1])?;
    out[len] = 0;
    Ok(len + 1)
}

/// A frame whose COBS and CRC checked out; the body is still postcard.
#[derive(Debug)]
pub struct Frame<'a> {
    pub seq: u16,
    pub body: &'a [u8],
}

impl Frame<'_> {
    pub fn parse<T: DeserializeOwned>(&self) -> Result<T, FrameError> {
        postcard::from_bytes(self.body).map_err(|_| FrameError::Decode)
    }
}

/// Decodes one COBS frame (delimiter stripped) in place and checks its CRC.
pub fn unframe(cobs: &mut [u8]) -> Result<Frame<'_>, FrameError> {
    let n = cobs_decode_in_place(cobs)?;
    if n < 6 {
        return Err(FrameError::Short);
    }
    let (data, crc) = cobs[..n].split_at(n - 4);
    let crc = u32::from_le_bytes([crc[0], crc[1], crc[2], crc[3]]);
    if CRC32.checksum(data) != crc {
        return Err(FrameError::BadCrc);
    }
    Ok(Frame { seq: u16::from_le_bytes([data[0], data[1]]), body: &data[2..] })
}

/// Splits a byte stream into frames at 0x00 delimiters. Bytes of a frame that
/// grows past `MAX_FRAME` are discarded up to the next delimiter. Empty frames
/// (repeated 0x00) are ignored, so a sender may emit a lone 0x00 to flush any
/// partial frame left in the receiver.
pub struct Accumulator {
    buf: [u8; MAX_FRAME],
    len: usize,
    overflow: bool,
}

impl Default for Accumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl Accumulator {
    pub const fn new() -> Self {
        Self { buf: [0; MAX_FRAME], len: 0, overflow: false }
    }

    /// Feeds received bytes. Calls `on_frame` with each complete COBS frame
    /// (pass it to [`unframe`]). Returns how many oversized frames were dropped.
    pub fn feed(&mut self, data: &[u8], mut on_frame: impl FnMut(&mut [u8])) -> u32 {
        let mut dropped = 0;
        for &b in data {
            if b == 0 {
                if self.overflow {
                    dropped += 1;
                } else if self.len > 0 {
                    on_frame(&mut self.buf[..self.len]);
                }
                self.len = 0;
                self.overflow = false;
            } else if self.len < MAX_FRAME {
                self.buf[self.len] = b;
                self.len += 1;
            } else {
                self.overflow = true;
            }
        }
        dropped
    }
}

/// Standard COBS without the trailing delimiter.
fn cobs_encode(src: &[u8], dst: &mut [u8]) -> Result<usize, FrameError> {
    let mut code_at = 0;
    let mut out = 1;
    let mut code: u8 = 1;
    for &b in src {
        if out >= dst.len() {
            return Err(FrameError::TooLong);
        }
        if b == 0 {
            dst[code_at] = code;
            code_at = out;
            out += 1;
            code = 1;
        } else {
            dst[out] = b;
            out += 1;
            code += 1;
            if code == 0xFF {
                if out >= dst.len() {
                    return Err(FrameError::TooLong);
                }
                dst[code_at] = code;
                code_at = out;
                out += 1;
                code = 1;
            }
        }
    }
    if code_at >= dst.len() {
        return Err(FrameError::TooLong);
    }
    dst[code_at] = code;
    Ok(out)
}

fn cobs_decode_in_place(buf: &mut [u8]) -> Result<usize, FrameError> {
    let (mut r, mut w) = (0, 0);
    while r < buf.len() {
        let code = buf[r] as usize;
        if code == 0 {
            return Err(FrameError::Cobs);
        }
        r += 1;
        let end = r + code - 1;
        if end > buf.len() {
            return Err(FrameError::Cobs);
        }
        while r < end {
            buf[w] = buf[r];
            w += 1;
            r += 1;
        }
        if code != 0xFF && r < buf.len() {
            buf[w] = 0;
            w += 1;
        }
    }
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip_cobs(data: &[u8]) {
        let mut enc = [0u8; 600];
        let n = cobs_encode(data, &mut enc).unwrap();
        assert!(!enc[..n].contains(&0), "encoded data must not contain 0x00");
        let mut dec = enc[..n].to_vec();
        let m = cobs_decode_in_place(&mut dec).unwrap();
        assert_eq!(&dec[..m], data);
    }

    #[test]
    fn cobs_edge_cases() {
        roundtrip_cobs(&[]);
        roundtrip_cobs(&[0]);
        roundtrip_cobs(&[0, 0]);
        roundtrip_cobs(&[1, 2, 0, 3]);
        roundtrip_cobs(&[0xAA; 253]);
        roundtrip_cobs(&[0xAA; 254]);
        roundtrip_cobs(&[0xAA; 255]);
        let mixed: Vec<u8> = (0..500u32).map(|i| (i * 7 % 256) as u8).collect();
        roundtrip_cobs(&mixed);
    }

    #[test]
    fn frame_roundtrip_both_directions() {
        let mut out = [0u8; MAX_FRAME];
        let req = Request::Matrix { rows: [0x1FFF, 0x1001, 0x1001, 0x1001, 0x1001, 0x1001, 0x1001, 0x1FFF] };
        let n = encode(0xBEEF, &req, &mut out).unwrap();
        assert_eq!(out[n - 1], 0);
        let mut wire = out[..n - 1].to_vec();
        let f = unframe(&mut wire).unwrap();
        assert_eq!(f.seq, 0xBEEF);
        assert_eq!(f.parse::<Request>().unwrap(), req);

        let up = Up::Response(Response::Info(Info {
            proto: PROTO_VERSION,
            fw: [0, 1, 0],
            uptime_ms: 123_456,
            reset_cause: ResetCause::IndependentWatchdog,
            uid: [0xFF; 12],
            failsafe: FailsafeState::Tripped,
            link: LinkCounters { frames: u32::MAX, bad_crc: 1, bad_frame: 2, uart_errors: 3 },
            last_panic: Some(PanicSite::new("/a/very/long/path/to/link/firmware/src/main.rs", 42, 7)),
        }));
        let n = encode(7, &up, &mut out).unwrap();
        assert!(n <= MAX_FRAME);
        let mut wire = out[..n - 1].to_vec();
        assert_eq!(unframe(&mut wire).unwrap().parse::<Up>().unwrap(), up);

        // v3: the front-panel button event.
        let ev = Up::Event(Event::Button { id: 0, pressed: true, t_ms: 4_000_000_000 });
        let n = encode(9, &ev, &mut out).unwrap();
        let mut wire = out[..n - 1].to_vec();
        assert_eq!(unframe(&mut wire).unwrap().parse::<Up>().unwrap(), ev);

        // v4: the LED&KEY module.
        for up in [Up::Event(Event::Panel { present: true }), Up::Event(Event::Button { id: PANEL_KEY_FIRST + 7, pressed: false, t_ms: 1 })] {
            let n = encode(10, &up, &mut out).unwrap();
            let mut wire = out[..n - 1].to_vec();
            assert_eq!(unframe(&mut wire).unwrap().parse::<Up>().unwrap(), up);
        }
        let req = Request::Panel { digits: [0xFF; PANEL_DIGITS], leds: 0xA5, level: 8 };
        let n = encode(11, &req, &mut out).unwrap();
        let mut wire = out[..n - 1].to_vec();
        assert_eq!(unframe(&mut wire).unwrap().parse::<Request>().unwrap(), req);
    }

    #[test]
    fn draw_batches_fit_in_a_frame() {
        let mut ops = heapless::Vec::<DrawOp, MAX_DRAW_OPS>::new();
        ops.push(DrawOp::Clear { color: rgb565(0, 0, 0) }).unwrap();
        ops.push(DrawOp::Text {
            x: 160,
            y: 2,
            font: Font::Medium,
            align: Align::Center,
            color: 0xFFFF,
            bg: Some(0),
            text: heapless::String::try_from("uriel  12:34:56  up 3h").unwrap(),
        })
        .unwrap();
        ops.push(DrawOp::Present).unwrap();
        let mut out = [0u8; MAX_FRAME];
        let n = encode(1, &Request::Draw { ops: ops.clone() }, &mut out).unwrap();
        let mut wire = out[..n - 1].to_vec();
        assert_eq!(unframe(&mut wire).unwrap().parse::<Request>().unwrap(), Request::Draw { ops });
        // A full bar graph alone must still fit, so hosts can always send it.
        let mut big = heapless::Vec::<DrawOp, MAX_DRAW_OPS>::new();
        let values = heapless::Vec::from_slice(&[100u8; MAX_BARS]).unwrap();
        big.push(DrawOp::Bars { x: 0, y: 0, h: 30, bar_w: 2, gap: 1, color: 0xFFFF, bg: Some(0), values }).unwrap();
        assert!(encode(2, &Request::Draw { ops: big }, &mut out).is_ok());
        assert_eq!(rgb565(255, 255, 255), 0xFFFF);
        assert_eq!(rgb565(255, 0, 0), 0xF800);
    }

    #[test]
    fn panic_site_keeps_the_path_tail() {
        let p = PanicSite::new("/a/very/long/path/to/link/firmware/src/main.rs", 1, 2);
        assert_eq!(p.file(), "to/link/firmware/src/main.rs"); // last 28 bytes
        assert_eq!(PanicSite::new("short.rs", 1, 2).file(), "short.rs");
    }

    #[test]
    fn every_single_byte_corruption_is_caught() {
        let mut out = [0u8; MAX_FRAME];
        let n = encode(1, &Request::Ping { nonce: 0x0102_0304 }, &mut out).unwrap();
        for i in 0..n - 1 {
            for flip in [0x01u8, 0x80, 0xFF] {
                let mut wire = out[..n - 1].to_vec();
                wire[i] ^= flip;
                if wire[i] == 0 {
                    continue; // becomes a delimiter: handled by the accumulator
                }
                assert!(unframe(&mut wire).is_err(), "byte {i} ^ {flip:#x} went undetected");
            }
        }
    }

    #[test]
    fn accumulator_resyncs_after_garbage() {
        let mut out = [0u8; MAX_FRAME];
        let mut stream = vec![0x13, 0x37, 0x42]; // partial garbage, no delimiter
        stream.push(0);
        for i in 0..3u16 {
            let n = encode(i, &Request::Ping { nonce: i as u32 }, &mut out).unwrap();
            stream.extend_from_slice(&out[..n]);
        }
        stream.extend(std::iter::repeat_n(0x55, MAX_FRAME + 10)); // oversized junk
        stream.push(0);
        let n = encode(9, &Request::GetInfo, &mut out).unwrap();
        stream.extend_from_slice(&out[..n]);

        let mut acc = Accumulator::new();
        let mut good = vec![];
        let mut bad = 0;
        // Feed in awkward chunk sizes to exercise frames split across reads.
        let mut dropped = 0;
        for chunk in stream.chunks(5) {
            dropped += acc.feed(chunk, |f| match unframe(f) {
                Ok(fr) => good.push((fr.seq, fr.parse::<Request>().unwrap())),
                Err(_) => bad += 1,
            });
        }
        assert_eq!(bad, 1, "the leading garbage is one bad frame");
        assert_eq!(dropped, 1, "the oversized junk is dropped");
        assert_eq!(good.len(), 4);
        assert_eq!(good[3], (9, Request::GetInfo));
    }
}
