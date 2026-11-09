//! qonu-mcp: MCP server for the Arduino UNO Q.
//!
//! Speaks MCP over stdio, so a client runs it through SSH
//! (`ssh uriel qonu-mcp`): no network listener on the board, and access is
//! whatever the SSH key allows. It never touches the UART or GPIOs itself; every
//! action goes through the qonu-link daemon's socket, which owns the MCU link
//! and its failsafe.

mod font;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::time::{Duration, Instant};

use qonu_link_proto::{MATRIX_HEIGHT as H, MATRIX_WIDTH as W};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{Json, ServerHandler, ServiceExt, tool, tool_handler, tool_router, transport::stdio};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

const SOCKET: &str = "/run/qonu/link.sock";
/// Longest an animation or scroll may run; keeps one tool call bounded.
const MAX_SHOW: Duration = Duration::from_secs(30);
const FONT_TOP: usize = 1; // glyph rows 1..=5 of the 8

const INSTRUCTIONS: &str = "\
Controls an Arduino UNO Q board: its 13x8 red LED matrix and an RGB LED, driven by \
the board's STM32 microcontroller.
Matrix coordinates: 13 columns (x = 0 is the left edge) by 8 rows (y = 0 is the top). \
Frames are 8 strings of 13 characters, top row first: '#' = LED on, '.' = off.
Use get_status first if unsure the board is reachable. The tools only change LEDs and \
are safe to call. If the board's link failsafe trips, the outputs go dark and tools \
report it; the link daemon recovers on its own.";

// ------------------------------------------------------------- link client

async fn link(method: &str, params: Value) -> Result<Value, String> {
    let io = |e: std::io::Error| format!("qonu-link daemon unreachable at {SOCKET}: {e}");
    let mut s = UnixStream::connect(SOCKET).await.map_err(io)?;
    let req = json!({"id": 1, "method": method, "params": params}).to_string() + "\n";
    s.write_all(req.as_bytes()).await.map_err(io)?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).await.map_err(io)?;
    let reply: Value = serde_json::from_str(&line).map_err(|e| format!("bad reply from qonu-link: {e}"))?;
    if reply["ok"] == true {
        Ok(reply["result"].clone())
    } else {
        Err(reply["error"].as_str().unwrap_or("unknown error").to_string())
    }
}

type Frame = [u16; H];

fn parse_frame(rows: &[String]) -> Result<Frame, String> {
    if rows.len() != H {
        return Err(format!("a frame needs exactly {H} rows, got {}", rows.len()));
    }
    let mut frame = [0u16; H];
    for (y, row) in rows.iter().enumerate() {
        let n = row.chars().count();
        if n != W {
            return Err(format!("row {y} has {n} characters; every row needs exactly {W}"));
        }
        for (x, c) in row.chars().enumerate() {
            match c {
                '#' => frame[y] |= 1 << x,
                '.' => {}
                other => return Err(format!("row {y}, column {x}: use '#' (on) or '.' (off), not {other:?}")),
            }
        }
    }
    Ok(frame)
}

fn frame_strings(frame: &Frame) -> Vec<String> {
    frame.iter().map(|row| (0..W).map(|x| if row >> x & 1 != 0 { '#' } else { '.' }).collect()).collect()
}

/// The 13-column window of `cols` starting at `start` (may run off either end).
fn window(cols: &[u8], start: isize) -> Frame {
    let mut frame = [0u16; H];
    for x in 0..W {
        let i = start + x as isize;
        if i < 0 || i as usize >= cols.len() {
            continue;
        }
        for r in 0..font::HEIGHT {
            if cols[i as usize] >> r & 1 != 0 {
                frame[FONT_TOP + r] |= 1 << x;
            }
        }
    }
    frame
}

// ------------------------------------------------------------ tool types

/// schemars tags numbers with formats like `uint32` or `double`, which JSON
/// Schema doesn't define and clients warn about; the type (and `minimum: 0` for
/// unsigned fields) already says enough.
fn no_uint_format(schema: &mut schemars::Schema) {
    let numeric = |f: &str| f.starts_with("uint") || f.starts_with("int") || f == "float" || f == "double";
    if schema.get("format").and_then(Value::as_str).is_some_and(numeric) {
        schema.remove("format");
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DrawParams {
    /// The frame: exactly 8 strings, top row first, each exactly 13 characters,
    /// '#' = LED on and '.' = off. Column 0 is the left edge.
    rows: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(transform = schemars::transform::RecursiveTransform(no_uint_format))]
struct TextParams {
    /// Text to show. Up to 3 characters fit and are shown centered; longer text
    /// scrolls from right to left. Letters (any case), digits, space and
    /// . , : ! ? - + = / ' < > ( ) * # % _ are supported. At most 40 characters.
    text: String,
    /// Milliseconds per one-column scroll step, 40-400 (default 90).
    speed_ms: Option<u32>,
    /// How many times to scroll the text across, 1-5 (default 1).
    loops: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(transform = schemars::transform::RecursiveTransform(no_uint_format))]
struct AnimateParams {
    /// Frames to play in order, 1-64 of them. Each frame is 8 strings of 13
    /// characters ('#' on, '.' off), the same format as matrix_draw.
    frames: Vec<Vec<String>>,
    /// Milliseconds each frame stays on, 40-2000 (default 150).
    frame_ms: Option<u32>,
    /// Times to play the sequence, 1-10 (default 1). The last frame stays shown.
    loops: Option<u32>,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Color {
    Off,
    Red,
    Green,
    Blue,
    Yellow,
    Cyan,
    Magenta,
    White,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct LedParams {
    /// Color for the RGB LED (LED3). Each channel is on or off, so these eight are all it can show.
    color: Color,
}

#[derive(Debug, Serialize, JsonSchema)]
#[schemars(transform = schemars::transform::RecursiveTransform(no_uint_format))]
struct MatrixResult {
    /// What the matrix shows now, in the matrix_draw format.
    shown: Vec<String>,
    lit_pixels: u32,
    /// Frames displayed by this call (1 for a static image).
    frames_shown: u32,
    /// True if a newer matrix command interrupted this one.
    interrupted: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
struct LedResult {
    color: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[schemars(transform = schemars::transform::RecursiveTransform(no_uint_format))]
struct Status {
    /// The link daemon is running and the MCU answered within the last second.
    link_up: bool,
    /// Firmware version on the STM32, e.g. "0.1.0".
    mcu_firmware: Option<String>,
    mcu_uptime_s: Option<f64>,
    /// Why the MCU last reset (PowerOn, Software, IndependentWatchdog, ...).
    mcu_reset_cause: Option<String>,
    /// Disarmed, Armed (normal) or Tripped (outputs forced dark).
    failsafe: Option<String>,
    /// Source location of the panic behind the last MCU reset, if any.
    mcu_last_panic: Option<String>,
    /// Median MCU round trip over recent calls, microseconds.
    link_rtt_p50_us: Option<u64>,
    /// Frames lost to CRC, framing or timeout since the daemon started.
    link_errors: Option<u64>,
    matrix_width: u32,
    matrix_height: u32,
    /// Set when the board couldn't be queried.
    error: Option<String>,
}

// ------------------------------------------------------------------ server

#[derive(Clone)]
struct Qonu {
    tool_router: ToolRouter<Self>,
    /// Bumped by every matrix command; running animations stop when it moves.
    generation: Arc<AtomicU64>,
}

impl Qonu {
    fn new() -> Self {
        Self { tool_router: Self::tool_router(), generation: Arc::new(AtomicU64::new(0)) }
    }

    async fn show(&self, frame: &Frame) -> Result<(), String> {
        link("matrix", json!({"rows": frame})).await.map(|_| ())
    }

    /// Plays frames with a fixed delay; stops early if another command takes over.
    async fn play(&self, frames: &[Frame], delay: Duration, loops: u32) -> Result<MatrixResult, String> {
        let generation = self.generation.fetch_add(1, SeqCst) + 1;
        let mut shown = 0;
        let mut last = [0u16; H];
        let mut tick = tokio::time::interval(delay);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        'outer: for _ in 0..loops {
            for frame in frames {
                tick.tick().await;
                if self.generation.load(SeqCst) != generation {
                    break 'outer;
                }
                self.show(frame).await?;
                last = *frame;
                shown += 1;
            }
        }
        Ok(MatrixResult {
            shown: frame_strings(&last),
            lit_pixels: last.iter().map(|r| r.count_ones()).sum(),
            frames_shown: shown,
            interrupted: self.generation.load(SeqCst) != generation,
        })
    }
}

fn check_duration(frames: usize, delay_ms: u32, loops: u32) -> Result<(), String> {
    let total = Duration::from_millis(frames as u64 * delay_ms as u64 * loops as u64);
    if total > MAX_SHOW {
        return Err(format!(
            "that would run {:.1} s; keep a single call under {} s (fewer frames, loops or a shorter delay)",
            total.as_secs_f64(),
            MAX_SHOW.as_secs()
        ));
    }
    Ok(())
}

#[tool_router]
impl Qonu {
    #[tool(
        description = "Board health: whether the STM32 link is up, MCU firmware version, uptime, last reset cause, failsafe state, link latency and error counts, and the LED matrix size.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn get_status(&self) -> Json<Status> {
        let mut st = Status {
            link_up: false,
            mcu_firmware: None,
            mcu_uptime_s: None,
            mcu_reset_cause: None,
            failsafe: None,
            mcu_last_panic: None,
            link_rtt_p50_us: None,
            link_errors: None,
            matrix_width: W as u32,
            matrix_height: H as u32,
            error: None,
        };
        match link("info", json!({})).await {
            Ok(i) => {
                st.mcu_firmware = i["fw"].as_array().map(|v| {
                    v.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(".")
                });
                st.mcu_uptime_s = i["uptime_ms"].as_f64().map(|ms| ms / 1000.0);
                st.mcu_reset_cause = i["reset_cause"].as_str().map(str::to_owned);
                st.failsafe = i["failsafe"].as_str().map(str::to_owned);
                st.mcu_last_panic = i["last_panic"].as_str().map(str::to_owned);
            }
            Err(e) => st.error = Some(e),
        }
        if let Ok(s) = link("stats", json!({})).await {
            st.link_up = s["link_up"] == true;
            st.link_rtt_p50_us = s["rtt_us"]["p50"].as_u64();
            let c = &s["counters"];
            st.link_errors = Some(["rx_bad_crc", "rx_bad_frame", "timeouts"].iter().filter_map(|k| c[k].as_u64()).sum());
        }
        Json(st)
    }

    #[tool(
        description = "Show a static image on the 13x8 LED matrix. Pass 8 rows (top first) of exactly 13 characters each: '#' = on, '.' = off. Replaces whatever is shown, including a running animation.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn matrix_draw(&self, Parameters(p): Parameters<DrawParams>) -> Result<Json<MatrixResult>, String> {
        let frame = parse_frame(&p.rows)?;
        self.play(&[frame], Duration::from_millis(1), 1).await.map(Json)
    }

    #[tool(
        description = "Turn every LED of the matrix off (also stops a running animation).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn matrix_clear(&self) -> Result<Json<MatrixResult>, String> {
        self.play(&[[0; H]], Duration::from_millis(1), 1).await.map(Json)
    }

    #[tool(
        description = "Write text on the LED matrix with a 3x5 font. Up to 3 characters are shown centered and stay; longer text scrolls right to left and the matrix is blank afterwards. Returns when done.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn matrix_text(&self, Parameters(p): Parameters<TextParams>) -> Result<Json<MatrixResult>, String> {
        if p.text.chars().count() > 40 {
            return Err("text is limited to 40 characters".into());
        }
        let cols = font::columns(&p.text)
            .map_err(|c| format!("the font has no glyph for {c:?}; supported: {}", font::charset()))?;
        if cols.len() <= W {
            let start = -((W - cols.len()) as isize / 2);
            return self.play(&[window(&cols, start)], Duration::from_millis(1), 1).await.map(Json);
        }
        let speed = p.speed_ms.unwrap_or(90).clamp(40, 400);
        let loops = p.loops.unwrap_or(1).clamp(1, 5);
        // Enter from the right edge, leave past the left edge.
        let frames: Vec<Frame> = (-(W as isize)..=cols.len() as isize).map(|s| window(&cols, s)).collect();
        check_duration(frames.len(), speed, loops)?;
        self.play(&frames, Duration::from_millis(speed as u64), loops).await.map(Json)
    }

    #[tool(
        description = "Play an animation on the LED matrix: a list of frames (each 8 rows of 13 '#'/'.' characters) shown in order at a fixed rate, optionally looped. Returns when done; the last frame stays shown. A single call may run at most 30 seconds.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn matrix_animate(&self, Parameters(p): Parameters<AnimateParams>) -> Result<Json<MatrixResult>, String> {
        if p.frames.is_empty() || p.frames.len() > 64 {
            return Err(format!("pass 1-64 frames, got {}", p.frames.len()));
        }
        let frames = p
            .frames
            .iter()
            .enumerate()
            .map(|(i, f)| parse_frame(f).map_err(|e| format!("frame {i}: {e}")))
            .collect::<Result<Vec<_>, _>>()?;
        let frame_ms = p.frame_ms.unwrap_or(150).clamp(40, 2000);
        let loops = p.loops.unwrap_or(1).clamp(1, 10);
        check_duration(frames.len(), frame_ms, loops)?;
        self.play(&frames, Duration::from_millis(frame_ms as u64), loops).await.map(Json)
    }

    #[tool(
        description = "Set the RGB LED (LED3) to one of eight colors, or off.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn set_led(&self, Parameters(p): Parameters<LedParams>) -> Result<Json<LedResult>, String> {
        let (r, g, b) = match p.color {
            Color::Off => (false, false, false),
            Color::Red => (true, false, false),
            Color::Green => (false, true, false),
            Color::Blue => (false, false, true),
            Color::Yellow => (true, true, false),
            Color::Cyan => (false, true, true),
            Color::Magenta => (true, false, true),
            Color::White => (true, true, true),
        };
        link("led", json!({"r": r, "g": g, "b": b})).await?;
        Ok(Json(LedResult { color: format!("{:?}", p.color).to_lowercase() }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Qonu {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("qonu-mcp", env!("CARGO_PKG_VERSION")).with_title("Arduino UNO Q (qonu)"))
            .with_instructions(INSTRUCTIONS.to_string())
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let started = Instant::now();
    match Qonu::new().serve(stdio()).await {
        Ok(service) => {
            let _ = service.waiting().await;
        }
        Err(e) => {
            eprintln!("qonu-mcp: {e} (after {:?})", started.elapsed());
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let rows: Vec<String> = ["#...........#"; 8].iter().map(|s| s.to_string()).collect();
        let f = parse_frame(&rows).unwrap();
        assert_eq!(f[0], 1 | 1 << 12);
        assert_eq!(frame_strings(&f), rows);
        assert!(parse_frame(&rows[..7]).is_err());
    }

    #[test]
    fn short_text_is_centered() {
        let cols = font::columns("HI").unwrap(); // 3 + 1 + 3 columns
        assert_eq!(cols.len(), 7);
        let f = window(&cols, -3); // 3 blank columns on the left
        assert_eq!(f[FONT_TOP] & 0b111, 0);
        assert_ne!(f[FONT_TOP] >> 3 & 1, 0); // H's left stroke at x = 3
        assert!(font::columns("é").is_err());
    }
}
