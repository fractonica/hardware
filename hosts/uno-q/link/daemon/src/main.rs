//! qonu-link: the Linux side of the qonu link to the UNO Q's STM32U585.
//!
//! `qonu-link daemon` owns the UART (`/dev/ttyHS1`), matches responses to
//! requests by `seq`, keeps the MCU's failsafe armed with heartbeats, and serves
//! a JSON-lines Unix socket. Every other subcommand is a client of that socket,
//! so exactly one process ever talks to the MCU.
//!
//! Socket protocol, one JSON object per line in each direction:
//!   -> {"id": 1, "method": "ping", "params": {}}
//!   <- {"id": 1, "ok": true, "result": {...}}   or   {"id": 1, "ok": false, "error": "..."}
//! Methods: ping, info, stats, led {r,g,b}, matrix {rows}, draw {ops}, panel {text|digits, leds, level},
//! panel_status, screen (what the display and the LED&KEY last showed), clear_failsafe, bench {n}, fault {kind};
//! subscribe (event lines from then on), press {id, pressed}.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicU16, Ordering::Relaxed};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{env, process, thread};

use qonu_link_proto::{
    self as proto, Accumulator, Align, DrawOp, ErrorCode, Event, FailsafeState, Fault, Font, FrameError, MATRIX_HEIGHT,
    MATRIX_WIDTH, MAX_DRAW_OPS, MAX_FRAME, PANEL_DIGITS, PANEL_KEY_FIRST, Request, Response, Up,
};
use serde_json::{Value, json};

const DEFAULT_DEVICE: &str = "/dev/ttyHS1";
const DEFAULT_BAUD: u32 = 4_000_000;
const DEFAULT_SOCKET: &str = "/run/qonu/link.sock";
const CALL_TIMEOUT: Duration = Duration::from_millis(100);
const HEARTBEAT_EVERY: Duration = Duration::from_millis(150);
const HEARTBEAT_TTL_MS: u16 = 600;
const RTT_WINDOW: usize = 1024;

// ------------------------------------------------------------------- link

#[derive(Default, Clone, serde::Serialize)]
struct Stats {
    rx_frames: u64,
    rx_bad_crc: u64,
    rx_bad_frame: u64,
    rx_unmatched: u64,
    tx_frames: u64,
    timeouts: u64,
    retries: u64,
    mcu_boots: u64,
    failsafe_trips: u64,
    failsafe_clears: u64,
}

#[derive(Default, Clone)]
struct Shown {
    draw: Value,
    panel: Value,
    matrix: Value,
    matrix_writes: u64,
}

struct Link {
    port: Mutex<File>,
    pending: Mutex<HashMap<u16, SyncSender<Response>>>,
    seq: AtomicU16,
    stats: Mutex<Stats>,
    rtts_us: Mutex<VecDeque<u32>>,
    last_rx: Mutex<Option<Instant>>,
    failsafe: Mutex<Option<FailsafeState>>,
    started: Instant,
    device: String,
    baud: u32,
    latch: bool,
    /// Connections that asked for `subscribe`: every MCU event goes to each as a JSON line.
    subscribers: Mutex<Vec<UnixStream>>,
    /// Whether the LED&KEY module answers, from the MCU's last `Event::Panel` (None: no event since we started).
    panel: Mutex<Option<bool>>,
    /// What the display, the LED&KEY and the matrix were last asked to show (the last `draw` list that ended in
    /// `present`, the last `panel` params, the last matrix rows and how many matrix writes so far), for `screen`:
    /// tests and agents read the panels without a camera.
    shown: Mutex<Shown>,
}

#[derive(Debug)]
enum CallError {
    Timeout,
    Io(io::Error),
    Encode,
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            CallError::Timeout => write!(f, "MCU did not answer within {} ms", CALL_TIMEOUT.as_millis()),
            CallError::Io(e) => write!(f, "serial write failed: {e}"),
            CallError::Encode => write!(f, "request too large to encode"),
        }
    }
}

impl Link {
    fn stat(&self, f: impl FnOnce(&mut Stats)) {
        f(&mut self.stats.lock().unwrap());
    }

    /// One request/response exchange, no retry.
    fn call_once(&self, req: &Request, timeout: Duration) -> Result<Response, CallError> {
        let seq = self.seq.fetch_add(1, Relaxed);
        let mut buf = [0u8; MAX_FRAME];
        let n = proto::encode(seq, req, &mut buf).map_err(|_| CallError::Encode)?;
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending.lock().unwrap().insert(seq, tx);
        let t0 = Instant::now();
        if let Err(e) = self.port.lock().unwrap().write_all(&buf[..n]) {
            self.pending.lock().unwrap().remove(&seq);
            return Err(CallError::Io(e));
        }
        self.stat(|s| s.tx_frames += 1);
        match rx.recv_timeout(timeout) {
            Ok(resp) => {
                let mut rtts = self.rtts_us.lock().unwrap();
                if rtts.len() == RTT_WINDOW {
                    rtts.pop_front();
                }
                rtts.push_back(t0.elapsed().as_micros() as u32);
                Ok(resp)
            }
            Err(_) => {
                self.pending.lock().unwrap().remove(&seq);
                self.stat(|s| s.timeouts += 1);
                Err(CallError::Timeout)
            }
        }
    }

    /// Every request in the protocol is idempotent, so one retry is safe.
    fn call(&self, req: &Request) -> Result<Response, CallError> {
        match self.call_once(req, CALL_TIMEOUT) {
            Err(CallError::Timeout) => {
                self.stat(|s| s.retries += 1);
                self.call_once(req, CALL_TIMEOUT)
            }
            r => r,
        }
    }

    fn link_up(&self) -> bool {
        self.last_rx.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(1))
    }

    /// One event line to every subscriber; a subscriber that cannot take it (gone, or 1 s stuck) is dropped.
    fn publish(&self, event: Value) {
        let line = format!("{event}\n");
        self.subscribers.lock().unwrap().retain_mut(|s| s.write_all(line.as_bytes()).is_ok());
    }

    fn on_frame(&self, cobs: &mut [u8]) {
        let frame = match proto::unframe(cobs) {
            Ok(f) => f,
            Err(FrameError::BadCrc) => return self.stat(|s| s.rx_bad_crc += 1),
            Err(_) => return self.stat(|s| s.rx_bad_frame += 1),
        };
        let Ok(up) = frame.parse::<Up>() else {
            return self.stat(|s| s.rx_bad_frame += 1);
        };
        self.stat(|s| s.rx_frames += 1);
        *self.last_rx.lock().unwrap() = Some(Instant::now());
        match up {
            Up::Response(resp) => match self.pending.lock().unwrap().remove(&frame.seq) {
                Some(tx) => {
                    let _ = tx.try_send(resp);
                }
                None => self.stat(|s| s.rx_unmatched += 1), // answer arrived after its timeout
            },
            Up::Event(Event::Boot { reset_cause }) => {
                eprintln!("mcu: booted (reset cause: {reset_cause:?})");
                self.stat(|s| s.mcu_boots += 1);
                *self.failsafe.lock().unwrap() = Some(FailsafeState::Disarmed);
                self.publish(json!({"event": "boot", "reset_cause": format!("{reset_cause:?}")}));
            }
            Up::Event(Event::Failsafe { state }) => {
                eprintln!("mcu: failsafe {state:?}");
                if state == FailsafeState::Tripped {
                    self.stat(|s| s.failsafe_trips += 1);
                }
                *self.failsafe.lock().unwrap() = Some(state);
                self.publish(json!({"event": "failsafe", "state": state}));
            }
            Up::Event(Event::Button { id, pressed, t_ms }) => {
                self.publish(json!({"event": "button", "id": id, "pressed": pressed, "t_ms": t_ms}));
            }
            Up::Event(Event::Panel { present }) => {
                eprintln!("mcu: LED&KEY module {}", if present { "found" } else { "gone" });
                *self.panel.lock().unwrap() = Some(present);
                self.publish(json!({"event": "panel", "present": present}));
            }
        }
    }

    fn stats_json(&self) -> Value {
        let mut rtts: Vec<u32> = self.rtts_us.lock().unwrap().iter().copied().collect();
        rtts.sort_unstable();
        json!({
            "device": self.device,
            "baud": self.baud,
            "uptime_s": self.started.elapsed().as_secs(),
            "link_up": self.link_up(),
            "failsafe": *self.failsafe.lock().unwrap(),
            "panel": *self.panel.lock().unwrap(),
            "latch": self.latch,
            "counters": *self.stats.lock().unwrap(),
            "rtt_us": percentiles(&rtts),
        })
    }
}

fn percentiles(sorted: &[u32]) -> Value {
    if sorted.is_empty() {
        return json!({"n": 0});
    }
    let at = |q: f64| sorted[((sorted.len() - 1) as f64 * q).round() as usize];
    json!({"n": sorted.len(), "p50": at(0.50), "p95": at(0.95), "p99": at(0.99), "max": sorted[sorted.len() - 1]})
}

// ----------------------------------------------------------------- serial

fn open_serial(path: &str, baud: u32, rtscts: bool) -> io::Result<File> {
    let speed = match baud {
        115_200 => libc::B115200,
        230_400 => libc::B230400,
        460_800 => libc::B460800,
        921_600 => libc::B921600,
        1_000_000 => libc::B1000000,
        2_000_000 => libc::B2000000,
        3_000_000 => libc::B3000000,
        4_000_000 => libc::B4000000,
        _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("unsupported baud {baud}"))),
    };
    let port = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOCTTY).open(path)?;
    let fd = port.as_raw_fd();
    // SAFETY: plain termios calls on a file descriptor we own.
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut t) != 0 {
            return Err(io::Error::last_os_error());
        }
        libc::cfmakeraw(&mut t);
        t.c_cflag |= libc::CLOCAL | libc::CREAD;
        if rtscts {
            t.c_cflag |= libc::CRTSCTS;
        } else {
            t.c_cflag &= !libc::CRTSCTS;
        }
        t.c_cc[libc::VMIN] = 1;
        t.c_cc[libc::VTIME] = 0;
        libc::cfsetispeed(&mut t, speed);
        libc::cfsetospeed(&mut t, speed);
        if libc::tcsetattr(fd, libc::TCSANOW, &t) != 0 {
            return Err(io::Error::last_os_error());
        }
        libc::tcflush(fd, libc::TCIOFLUSH);
    }
    Ok(port)
}

fn reader(link: Arc<Link>, mut port: File) {
    let mut acc = Accumulator::new();
    let mut buf = [0u8; 512];
    loop {
        match port.read(&mut buf) {
            Ok(0) => thread::sleep(Duration::from_millis(10)),
            Ok(n) => {
                let dropped = acc.feed(&buf[..n], |f| link.on_frame(f));
                if dropped > 0 {
                    link.stat(|s| s.rx_bad_frame += dropped as u64);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => {
                eprintln!("serial read failed: {e}; exiting so systemd restarts us");
                process::exit(1);
            }
        }
    }
}

fn heartbeat(link: Arc<Link>) {
    let mut failures = 0u32;
    let mut up = true;
    loop {
        thread::sleep(HEARTBEAT_EVERY);
        match link.call_once(&Request::Heartbeat { ttl_ms: HEARTBEAT_TTL_MS }, CALL_TIMEOUT) {
            Ok(resp) => {
                if !up {
                    eprintln!("link: MCU answering again");
                    up = true;
                }
                failures = 0;
                if resp == Response::Error(ErrorCode::FailsafeTripped) && !link.latch {
                    // The trip came from heartbeats we failed to deliver; we are
                    // healthy again, so leave the safe state. With --latch an
                    // operator has to clear it.
                    if let Ok(Response::Ok) = link.call(&Request::ClearFailsafe) {
                        link.stat(|s| s.failsafe_clears += 1);
                        eprintln!("failsafe: cleared after the link recovered");
                    }
                }
            }
            Err(_) => {
                failures += 1;
                if up && failures >= 3 {
                    eprintln!("link: MCU not answering heartbeats");
                    up = false;
                }
            }
        }
    }
}

// ----------------------------------------------------------------- server

fn serve(link: Arc<Link>, path: &str) -> io::Result<()> {
    if let Some(dir) = Path::new(path).parent() {
        fs::create_dir_all(dir)?;
    }
    let _ = fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o660))?;
    eprintln!("serving {path}");
    for conn in listener.incoming().flatten() {
        let link = link.clone();
        thread::spawn(move || {
            let _ = client_session(&link, conn);
        });
    }
    Ok(())
}

fn client_session(link: &Link, conn: UnixStream) -> io::Result<()> {
    let mut out = conn.try_clone()?;
    for line in BufReader::new(conn).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) if req["method"] == "press" => {
                // A button event that did not come from the MCU (testing, or an agent driving the panel): the same
                // line subscribers get from a real press, marked injected.
                let id = req["params"]["id"].as_u64().filter(|id| *id < PANEL_KEY_FIRST as u64 + 8);
                let pressed = req["params"]["pressed"].as_bool().unwrap_or(true);
                match id {
                    Some(id) => {
                        link.publish(json!({"event": "button", "id": id, "pressed": pressed, "t_ms": 0, "injected": true}));
                        json!({"id": req["id"], "ok": true, "result": {}})
                    }
                    None => json!({"id": req["id"], "ok": false, "error": "params.id (0 confirm, 1 up, 2 down, 8..15 the LED&KEY keys S1..S8) is required"}),
                }
            }
            Ok(req) if req["method"] == "subscribe" => {
                // From now on this connection also carries event lines ({"event": ...}), between replies.
                let sub = out.try_clone()?;
                sub.set_write_timeout(Some(Duration::from_secs(1)))?;
                link.subscribers.lock().unwrap().push(sub);
                json!({"id": req["id"], "ok": true, "result": {"events": ["boot", "failsafe", "button", "panel"]}})
            }
            Ok(req) => dispatch(link, &req),
            Err(e) => json!({"id": null, "ok": false, "error": format!("bad JSON: {e}")}),
        };
        writeln!(out, "{reply}")?;
    }
    Ok(())
}

/// Matrix rows from JSON: 8 entries, top first, each either a 13-bit number
/// (bit x = column x) or a 13-character string where `#`, `X`, `*`, `O`, `@`
/// or `1` is lit and `.`, ` `, `-`, `_` or `0` is dark.
fn parse_matrix(rows: &Value) -> Result<[u16; MATRIX_HEIGHT], String> {
    let arr = rows.as_array().filter(|a| a.len() == MATRIX_HEIGHT).ok_or("rows must be an array of 8 rows")?;
    let mut out = [0u16; MATRIX_HEIGHT];
    for (y, row) in arr.iter().enumerate() {
        out[y] = match row {
            Value::Number(n) => n
                .as_u64()
                .filter(|&n| n < 1 << MATRIX_WIDTH)
                .ok_or_else(|| format!("row {y}: numbers must be 0..8191"))? as u16,
            Value::String(s) => {
                if s.chars().count() != MATRIX_WIDTH {
                    return Err(format!("row {y}: needs exactly {MATRIX_WIDTH} characters, got {}", s.chars().count()));
                }
                let mut bits = 0u16;
                for (x, c) in s.chars().enumerate() {
                    match c {
                        '#' | 'X' | 'x' | '*' | 'O' | '@' | '1' => bits |= 1 << x,
                        '.' | ' ' | '-' | '_' | '0' => {}
                        other => return Err(format!("row {y}: '{other}' is neither lit (#) nor dark (.)")),
                    }
                }
                bits
            }
            _ => return Err(format!("row {y}: must be a number or a string")),
        };
    }
    Ok(out)
}

/// "#rrggbb", "#rgb" or a raw RGB565 number.
fn parse_color(v: &Value) -> Result<u16, String> {
    match v {
        Value::Number(n) => n.as_u64().filter(|&n| n <= 0xFFFF).map(|n| n as u16).ok_or("RGB565 colors are 0..65535".into()),
        Value::String(s) => {
            let hex = s.strip_prefix('#').unwrap_or(s);
            let byte = |i: usize, w: usize| u8::from_str_radix(&hex[i..i + w], 16).map(|b| if w == 1 { b * 17 } else { b });
            let rgb = match hex.len() {
                6 => (byte(0, 2), byte(2, 2), byte(4, 2)),
                3 => (byte(0, 1), byte(1, 1), byte(2, 1)),
                _ => return Err(format!("color {s:?}: use #rrggbb or #rgb")),
            };
            match rgb {
                (Ok(r), Ok(g), Ok(b)) => Ok(proto::rgb565(r, g, b)),
                _ => Err(format!("color {s:?}: not hex")),
            }
        }
        _ => Err("color must be \"#rrggbb\" or a number".into()),
    }
}

/// One draw op from JSON, e.g. {"op":"text","x":4,"y":2,"text":"hi","font":"large","color":"#fff"}.
fn parse_op(o: &Value) -> Result<DrawOp, String> {
    let int = |k: &str, default: Option<i64>| -> Result<i64, String> {
        match o.get(k) {
            Some(v) => v.as_i64().ok_or_else(|| format!("{k} must be an integer")),
            None => default.ok_or_else(|| format!("{k} is required")),
        }
    };
    let i16_ = |k: &str| int(k, None).map(|v| v.clamp(i16::MIN as i64, i16::MAX as i64) as i16);
    let u16_ = |k: &str, d: Option<i64>| int(k, d).map(|v| v.clamp(0, u16::MAX as i64) as u16);
    let u8_ = |k: &str, d: Option<i64>| int(k, d).map(|v| v.clamp(0, 255) as u8);
    let color = |k: &str| o.get(k).map(parse_color).unwrap_or(Ok(0xFFFF));
    let bg = || o.get("bg").filter(|v| !v.is_null()).map(parse_color).transpose();
    Ok(match o.get("op").and_then(Value::as_str).unwrap_or("") {
        "clear" => DrawOp::Clear { color: o.get("color").map(parse_color).unwrap_or(Ok(0))? },
        "rect" => DrawOp::Rect {
            x: i16_("x")?,
            y: i16_("y")?,
            w: u16_("w", None)?,
            h: u16_("h", None)?,
            color: color("color")?,
            filled: o.get("filled").and_then(Value::as_bool).unwrap_or(true),
        },
        "line" => DrawOp::Line {
            x0: i16_("x0")?,
            y0: i16_("y0")?,
            x1: i16_("x1")?,
            y1: i16_("y1")?,
            color: color("color")?,
            width: u8_("width", Some(1))?,
        },
        "text" => {
            let s = o.get("text").and_then(Value::as_str).ok_or("text is required")?;
            DrawOp::Text {
                x: i16_("x")?,
                y: i16_("y")?,
                font: match o.get("font").and_then(Value::as_str).unwrap_or("medium") {
                    "small" => Font::Small,
                    "medium" => Font::Medium,
                    "large" => Font::Large,
                    "huge" => Font::Huge,
                    f => return Err(format!("font {f:?}: small, medium, large or huge")),
                },
                align: match o.get("align").and_then(Value::as_str).unwrap_or("left") {
                    "left" => Align::Left,
                    "center" => Align::Center,
                    "right" => Align::Right,
                    a => return Err(format!("align {a:?}: left, center or right")),
                },
                color: color("color")?,
                bg: bg()?,
                text: heapless::String::try_from(s).map_err(|_| format!("text {s:?} is over {} bytes", proto::MAX_TEXT))?,
            }
        }
        "bars" => {
            let values: Vec<u8> = o
                .get("values")
                .and_then(Value::as_array)
                .ok_or("values (0-100 each) are required")?
                .iter()
                .map(|v| v.as_f64().map(|f| f.clamp(0.0, 100.0).round() as u8).ok_or("values must be numbers"))
                .collect::<Result<_, _>>()?;
            DrawOp::Bars {
                x: i16_("x")?,
                y: i16_("y")?,
                h: u16_("h", None)?,
                bar_w: u8_("bar_w", Some(2))?,
                gap: u8_("gap", Some(1))?,
                color: color("color")?,
                bg: bg()?,
                values: heapless::Vec::from_slice(&values).map_err(|_| format!("at most {} values", proto::MAX_BARS))?,
            }
        }
        "bitmap" => {
            // rows: equal-length strings, `#` (or 1, X, *) set and `.` (or 0, space) clear; top row first.
            let rows: Vec<&str> = o
                .get("rows")
                .and_then(Value::as_array)
                .ok_or("rows (strings of # and .) are required")?
                .iter()
                .map(|r| r.as_str().ok_or("rows must be strings"))
                .collect::<Result<_, _>>()?;
            let w = rows.first().map_or(0, |r| r.chars().count());
            if w == 0 || w > 255 || rows.len() > 255 || rows.iter().any(|r| r.chars().count() != w) {
                return Err("rows must be 1-255 strings of the same length (1-255)".into());
            }
            let stride = w.div_ceil(8);
            let mut bits = vec![0u8; stride * rows.len()];
            for (y, row) in rows.iter().enumerate() {
                for (x, c) in row.chars().enumerate() {
                    if matches!(c, '#' | '1' | 'X' | 'x' | '*') {
                        bits[y * stride + x / 8] |= 0x80 >> (x % 8);
                    }
                }
            }
            DrawOp::Bitmap {
                x: i16_("x")?,
                y: i16_("y")?,
                w: w as u8,
                h: rows.len() as u8,
                scale: u8_("scale", Some(1))?,
                fg: color("fg")?,
                bg: bg()?,
                bits: heapless::Vec::from_slice(&bits).map_err(|_| format!("at most {} bitmap bytes", proto::MAX_BITMAP))?,
            }
        }
        "present" => DrawOp::Present,
        "backlight" => DrawOp::Backlight { on: o.get("on").and_then(Value::as_bool).unwrap_or(true) },
        other => return Err(format!("unknown op {other:?}: clear, rect, line, text, bars, bitmap, present, backlight")),
    })
}

/// Sends ops in as few frames as fit. Returns how many frames it took.
fn draw(link: &Link, ops: &[Value]) -> Result<usize, String> {
    let ops = ops.iter().enumerate().map(|(i, o)| parse_op(o).map_err(|e| format!("op {i}: {e}"))).collect::<Result<Vec<_>, _>>()?;
    let fits = |batch: &heapless::Vec<DrawOp, MAX_DRAW_OPS>| {
        proto::encode(0, &Request::Draw { ops: batch.clone() }, &mut [0u8; MAX_FRAME]).is_ok()
    };
    let send = |batch: heapless::Vec<DrawOp, MAX_DRAW_OPS>| expect_ok(link.call(&Request::Draw { ops: batch }));
    let mut batch = heapless::Vec::<DrawOp, MAX_DRAW_OPS>::new();
    let mut frames = 0;
    for (i, op) in ops.into_iter().enumerate() {
        if batch.push(op.clone()).is_err() || !fits(&batch) {
            batch.pop();
            if batch.is_empty() {
                return Err(format!("op {i} alone is too large for one frame"));
            }
            send(std::mem::take(&mut batch))?;
            frames += 1;
            batch.push(op).ok();
            if !fits(&batch) {
                return Err(format!("op {i} alone is too large for one frame"));
            }
        }
    }
    if !batch.is_empty() {
        send(batch)?;
        frames += 1;
    }
    Ok(frames)
}

fn expect_ok(r: Result<Response, CallError>) -> Result<Value, String> {
    match r {
        Ok(Response::Ok) => Ok(json!("ok")),
        Ok(Response::Error(code)) => Err(format!("MCU refused: {code:?}")),
        Ok(other) => Err(format!("unexpected answer: {other:?}")),
        Err(e) => Err(e.to_string()),
    }
}

/// A seven-segment glyph (bit 0 = a, top, .. bit 6 = g, middle): digits, letters in whichever case reads better,
/// a few signs; anything else shows as three bars.
fn seg7(c: char) -> u8 {
    match c {
        ' ' => 0x00,
        '0' | 'O' => 0x3F,
        '1' => 0x06,
        '2' | 'Z' | 'z' => 0x5B,
        '3' => 0x4F,
        '4' => 0x66,
        '5' | 'S' | 's' => 0x6D,
        '6' => 0x7D,
        '7' => 0x07,
        '8' => 0x7F,
        '9' | 'g' => 0x6F,
        'A' | 'a' => 0x77,
        'B' | 'b' => 0x7C,
        'C' | '[' | '(' | '{' => 0x39,
        'c' => 0x58,
        'D' | 'd' => 0x5E,
        'E' => 0x79,
        'e' => 0x7B,
        'F' | 'f' => 0x71,
        'G' => 0x3D,
        'H' | 'X' | 'x' => 0x76,
        'h' => 0x74,
        'I' | 'l' | '|' => 0x30,
        'i' => 0x10,
        'J' | 'j' => 0x1E,
        'K' | 'k' => 0x75,
        'L' => 0x38,
        'M' | 'm' => 0x37,
        'N' | 'n' => 0x54,
        'o' => 0x5C,
        'P' | 'p' => 0x73,
        'Q' | 'q' => 0x67,
        'R' | 'r' => 0x50,
        'T' | 't' => 0x78,
        'U' | 'V' => 0x3E,
        'u' | 'v' => 0x1C,
        'W' | 'w' => 0x2A,
        'Y' | 'y' => 0x6E,
        ']' | ')' | '}' => 0x0F,
        '-' | '~' => 0x40,
        '_' => 0x08,
        '=' => 0x48,
        '"' => 0x22,
        '\'' | '`' => 0x20,
        '?' => 0x53,
        '°' | '^' => 0x63,
        '/' => 0x52,
        '\\' => 0x64,
        _ => 0x49,
    }
}

/// Text to the LED&KEY's 8 digits, left aligned: a `.` (or `,` `:`) lights the decimal point of the digit before it.
fn panel_text(text: &str) -> [u8; PANEL_DIGITS] {
    let mut digits = [0u8; PANEL_DIGITS];
    let mut n = 0;
    for c in text.chars() {
        if matches!(c, '.' | ',' | ':') && n > 0 && digits[n - 1] & 0x80 == 0 {
            digits[n - 1] |= 0x80;
            continue;
        }
        if n == PANEL_DIGITS {
            break;
        }
        digits[n] = if matches!(c, '.' | ',' | ':') { 0x80 } else { seg7(c) };
        n += 1;
    }
    digits
}

/// `panel` params: `text` (or `digits`, 8 raw segment bytes), `leds` (a bitmask, bit 0 = LED 1, or 8 booleans) and
/// `level` (0 off, 1-8; default 4).
fn parse_panel(p: &Value) -> Result<([u8; PANEL_DIGITS], u8, u8), String> {
    let digits = match (p.get("digits"), p.get("text")) {
        (Some(d), _) => {
            let v = d.as_array().filter(|a| a.len() == PANEL_DIGITS).ok_or("params.digits must be 8 numbers")?;
            let mut out = [0u8; PANEL_DIGITS];
            for (o, x) in out.iter_mut().zip(v) {
                *o = x.as_u64().filter(|b| *b <= 0xFF).ok_or("params.digits entries are 0-255")? as u8;
            }
            out
        }
        (None, Some(t)) => panel_text(t.as_str().ok_or("params.text must be a string")?),
        (None, None) => [0; PANEL_DIGITS],
    };
    let leds = match p.get("leds") {
        None => 0,
        Some(Value::Array(a)) => a.iter().take(8).enumerate().fold(0u8, |m, (i, v)| {
            if v.as_bool().unwrap_or(false) || v.as_u64().unwrap_or(0) != 0 { m | 1 << i } else { m }
        }),
        Some(v) => v.as_u64().filter(|m| *m <= 0xFF).ok_or("params.leds is a bitmask 0-255 or 8 booleans")? as u8,
    };
    let level = p.get("level").map_or(Some(4), Value::as_u64).filter(|l| *l <= 8).ok_or("params.level is 0 (off) to 8")? as u8;
    Ok((digits, leds, level))
}

fn dispatch(link: &Link, req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
    let flag = |k: &str| params.get(k).and_then(Value::as_bool).unwrap_or(false);

    let result: Result<Value, String> = match method {
        "ping" => {
            let nonce = (link.started.elapsed().as_nanos() as u32) | 1;
            let t0 = Instant::now();
            // params.timeout_ms: one try with a longer wait, to measure a slow MCU.
            let answer = match params.get("timeout_ms").and_then(Value::as_u64) {
                Some(ms) => link.call_once(&Request::Ping { nonce }, Duration::from_millis(ms.clamp(1, 10_000))),
                None => link.call(&Request::Ping { nonce }),
            };
            match answer {
                Ok(Response::Pong { nonce: n, uptime_ms }) if n == nonce => {
                    Ok(json!({"rtt_us": t0.elapsed().as_micros() as u64, "mcu_uptime_ms": uptime_ms}))
                }
                Ok(other) => Err(format!("unexpected answer: {other:?}")),
                Err(e) => Err(e.to_string()),
            }
        }
        "info" => match link.call(&Request::GetInfo) {
            Ok(Response::Info(info)) => {
                let panic = info.last_panic.map(|p| format!("{}:{}:{}", p.file(), p.line, p.column));
                serde_json::to_value(info)
                    .map(|mut v| {
                        v["last_panic"] = json!(panic);
                        v
                    })
                    .map_err(|e| e.to_string())
            }
            Ok(other) => Err(format!("unexpected answer: {other:?}")),
            Err(e) => Err(e.to_string()),
        },
        "led" => expect_ok(link.call(&Request::SetLed { led: 0, r: flag("r"), g: flag("g"), b: flag("b") })),
        "clear_failsafe" => expect_ok(link.call(&Request::ClearFailsafe)),
        "draw" => match params.get("ops").and_then(Value::as_array) {
            Some(ops) => draw(link, ops).map(|frames| {
                if ops.last().is_some_and(|o| o["op"] == "present") {
                    link.shown.lock().unwrap().draw = json!(ops);
                }
                json!({"ops": ops.len(), "frames": frames})
            }),
            None => Err("params.ops must be an array of draw ops".into()),
        },
        "panel_status" => match link.call(&Request::PanelStatus) {
            Ok(Response::Panel { present }) => {
                *link.panel.lock().unwrap() = Some(present);
                Ok(json!({"present": present}))
            }
            Ok(other) => Err(format!("unexpected answer: {other:?}")),
            Err(e) => Err(e.to_string()),
        },
        "panel" => parse_panel(&params).and_then(|(digits, leds, level)| {
            let r = expect_ok(link.call(&Request::Panel { digits, leds, level }));
            if r.is_ok() {
                link.shown.lock().unwrap().panel = params.clone();
            }
            r
        }),
        "screen" => {
            let sh = link.shown.lock().unwrap().clone();
            let texts: Vec<Value> = sh.draw.as_array().into_iter().flatten().filter(|o| o["op"] == "text").map(|o| o["text"].clone()).collect();
            let matrix: Vec<String> = sh.matrix.as_array().into_iter().flatten()
                .map(|r| (0..MATRIX_WIDTH).map(|x| if r.as_u64().unwrap_or(0) >> x & 1 != 0 { '#' } else { '.' }).collect())
                .collect();
            Ok(json!({"texts": texts, "ops": sh.draw, "panel": sh.panel, "matrix": matrix, "matrix_writes": sh.matrix_writes}))
        }
        "matrix" => match params.get("rows").map(parse_matrix) {
            Some(Ok(rows)) => expect_ok(link.call(&Request::Matrix { rows })).inspect(|_| {
                let mut sh = link.shown.lock().unwrap();
                sh.matrix = json!(rows);
                sh.matrix_writes += 1;
            }),
            Some(Err(e)) => Err(e),
            None => Err("params.rows is required".into()),
        },
        "fault" => {
            let kind = match params.get("kind").and_then(Value::as_str) {
                Some("hang") => Some(Fault::Hang),
                Some("panic") => Some(Fault::Panic),
                _ => None,
            };
            match kind {
                // No answer is expected: the MCU resets and announces Boot.
                Some(kind) => match link.call_once(&Request::Fault { kind }, CALL_TIMEOUT) {
                    Err(CallError::Timeout) => Ok(json!("sent; the MCU should reset and report Boot")),
                    Ok(other) => Err(format!("unexpected answer: {other:?}")),
                    Err(e) => Err(e.to_string()),
                },
                None => Err("params.kind must be \"hang\" or \"panic\"".into()),
            }
        }
        "stats" => Ok(link.stats_json()),
        "bench" => {
            let n = params.get("n").and_then(Value::as_u64).unwrap_or(1000).clamp(1, 100_000) as usize;
            let mut rtts = Vec::with_capacity(n);
            let mut failed = 0;
            let t0 = Instant::now();
            for i in 0..n {
                let t = Instant::now();
                match link.call_once(&Request::Ping { nonce: i as u32 }, CALL_TIMEOUT) {
                    Ok(Response::Pong { nonce, .. }) if nonce == i as u32 => rtts.push(t.elapsed().as_micros() as u32),
                    _ => failed += 1,
                }
            }
            let secs = t0.elapsed().as_secs_f64();
            rtts.sort_unstable();
            Ok(json!({"calls": n, "failed": failed, "calls_per_s": (n as f64 / secs).round(), "rtt_us": percentiles(&rtts)}))
        }
        "" => Err("missing \"method\"".into()),
        other => Err(format!("unknown method '{other}'")),
    };
    match result {
        Ok(v) => json!({"id": id, "ok": true, "result": v}),
        Err(e) => json!({"id": id, "ok": false, "error": e}),
    }
}

// ----------------------------------------------------------------- daemon

fn daemon(args: &[String]) -> io::Result<()> {
    let mut device = DEFAULT_DEVICE.to_string();
    let mut baud = DEFAULT_BAUD;
    let mut socket = env::var("QONU_LINK_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET.into());
    let mut latch = false;
    let mut rtscts = true;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--device" => device = it.next().cloned().unwrap_or(device),
            "--baud" => baud = it.next().and_then(|b| b.parse().ok()).unwrap_or(baud),
            "--socket" => socket = it.next().cloned().unwrap_or(socket),
            "--latch" => latch = true,
            "--rtscts" => rtscts = true,
            "--no-rtscts" => rtscts = false,
            other => return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("unknown option {other}"))),
        }
    }

    let port = open_serial(&device, baud, rtscts)?;
    let rx_port = port.try_clone()?;
    let link = Arc::new(Link {
        port: Mutex::new(port),
        pending: Mutex::new(HashMap::new()),
        seq: AtomicU16::new(1),
        stats: Mutex::new(Stats::default()),
        rtts_us: Mutex::new(VecDeque::with_capacity(RTT_WINDOW)),
        last_rx: Mutex::new(None),
        failsafe: Mutex::new(None),
        started: Instant::now(),
        device: device.clone(),
        baud,
        latch,
        subscribers: Mutex::new(Vec::new()),
        panel: Mutex::new(None),
        shown: Mutex::new(Shown::default()),
    });
    eprintln!(
        "qonu-link {} on {device} at {baud} baud{}{}",
        env!("CARGO_PKG_VERSION"),
        if rtscts { ", RTS/CTS" } else { "" },
        if latch { ", failsafe latched" } else { "" }
    );

    // A lone delimiter flushes any partial frame the MCU is holding.
    link.port.lock().unwrap().write_all(&[0])?;
    {
        let link = link.clone();
        thread::spawn(move || reader(link, rx_port));
    }
    match link.call(&Request::GetInfo) {
        Ok(Response::Info(i)) => {
            eprintln!(
                "mcu: qonu-fw {}.{}.{}, protocol {}, up {} ms, reset cause {:?}, failsafe {:?}{}",
                i.fw[0], i.fw[1], i.fw[2], i.proto, i.uptime_ms, i.reset_cause, i.failsafe,
                i.last_panic.map(|p| format!(", last panic at {}:{}:{}", p.file(), p.line, p.column)).unwrap_or_default()
            );
            if i.proto != proto::PROTO_VERSION {
                eprintln!("warning: MCU speaks protocol {}, we speak {}", i.proto, proto::PROTO_VERSION);
            }
            *link.failsafe.lock().unwrap() = Some(i.failsafe);
            if let Ok(Response::Panel { present }) = link.call(&Request::PanelStatus) {
                eprintln!("mcu: LED&KEY module {}", if present { "present" } else { "not found" });
                *link.panel.lock().unwrap() = Some(present);
            }
        }
        Ok(other) => eprintln!("mcu: unexpected answer to GetInfo: {other:?}"),
        Err(e) => eprintln!("mcu: no answer yet ({e}); will keep trying"),
    }
    {
        let link = link.clone();
        thread::spawn(move || heartbeat(link));
    }
    serve(link, &socket)
}

// ------------------------------------------------------------------- CLI

fn request(method: &str, params: Value) -> Result<Value, String> {
    let socket = env::var("QONU_LINK_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET.into());
    let mut s = UnixStream::connect(&socket).map_err(|e| format!("{socket}: {e} (is qonu-link daemon running?)"))?;
    writeln!(s, "{}", json!({"id": 1, "method": method, "params": params})).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
    let reply: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if reply["ok"].as_bool() == Some(true) {
        Ok(reply["result"].clone())
    } else {
        Err(reply["error"].as_str().unwrap_or("unknown error").to_string())
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: qonu-link daemon [--device {DEFAULT_DEVICE}] [--baud {DEFAULT_BAUD}] [--no-rtscts] [--socket PATH] [--latch]
       qonu-link ping [COUNT]       round trips to the MCU
       qonu-link info               firmware, uptime, reset cause, MCU-side counters
       qonu-link stats              daemon-side counters and latency
       qonu-link led R G B          LED3, each 0 or 1
       qonu-link matrix ROW x8      13-char rows, # lit . dark (or: qonu-link matrix clear)
       qonu-link clear              leave a latched failsafe
       qonu-link bench [N]          N back-to-back pings, latency percentiles
       qonu-link fault hang|panic   break the firmware on purpose to test recovery
       qonu-link panel TEXT [LEDS] [LEVEL]  the LED&KEY module: 8 characters, LEDs as 8 0/1 digits
                                    (LED 1 first), brightness 1-8; qonu-link panel off
       qonu-link screen             what the panels show: the display's texts, the LED&KEY, the matrix
       qonu-link events             print MCU events (button, panel, boot, failsafe) as JSON lines
       qonu-link press confirm|up|down|s1..s8   act as a button or LED&KEY key press (tests, agents)
       qonu-link call METHOD [JSON] raw socket request"
    );
    process::exit(2)
}

/// `qonu-link events`: subscribes and prints every MCU event line until interrupted.
fn events() -> Result<(), String> {
    let socket = env::var("QONU_LINK_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET.into());
    let mut s = UnixStream::connect(&socket).map_err(|e| format!("{socket}: {e} (is qonu-link daemon running?)"))?;
    writeln!(s, "{}", json!({"id": 1, "method": "subscribe", "params": {}})).map_err(|e| e.to_string())?;
    for line in BufReader::new(s).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.contains("\"event\"") {
            println!("{line}");
        }
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).map(String::as_str);
    let pretty = |v: Value| println!("{}", serde_json::to_string_pretty(&v).unwrap());
    let result = match arg(0) {
        Some("daemon") => daemon(&args[1..]).map_err(|e| e.to_string()),
        Some("ping") => {
            let count: u32 = arg(1).and_then(|c| c.parse().ok()).unwrap_or(4);
            let mut res = Ok(());
            for i in 0..count {
                match request("ping", json!({})) {
                    Ok(v) => println!("pong: rtt {} us, mcu up {} ms", v["rtt_us"], v["mcu_uptime_ms"]),
                    Err(e) => {
                        res = Err(e);
                        break;
                    }
                }
                if i + 1 < count {
                    thread::sleep(Duration::from_millis(200));
                }
            }
            res
        }
        Some(m @ ("info" | "stats")) => request(m, json!({})).map(pretty),
        Some("screen") => request("screen", json!({}))
            .map(|v| pretty(json!({"texts": v["texts"], "panel": v["panel"], "matrix": v["matrix"], "matrix_writes": v["matrix_writes"]}))),
        Some("clear") => request("clear_failsafe", json!({})).map(pretty),
        Some("matrix") => {
            let rows: Vec<Value> = if arg(1) == Some("clear") {
                vec![json!(0); MATRIX_HEIGHT]
            } else {
                args[1..].iter().map(|r| json!(r)).collect()
            };
            request("matrix", json!({"rows": rows})).map(pretty)
        }
        Some("led") => {
            let on = |i| arg(i) == Some("1");
            request("led", json!({"r": on(1), "g": on(2), "b": on(3)})).map(pretty)
        }
        Some("fault") => request("fault", json!({"kind": arg(1).unwrap_or("")})).map(pretty),
        Some("events") => events(),
        Some("panel") => {
            let params = if arg(1) == Some("off") {
                json!({"level": 0})
            } else {
                let leds: Vec<bool> = arg(2).unwrap_or("").chars().map(|c| c == '1').collect();
                let level = arg(3).and_then(|l| l.parse::<u64>().ok()).unwrap_or(4);
                json!({"text": arg(1).unwrap_or(""), "leds": leds, "level": level})
            };
            request("panel", params).map(pretty)
        }
        Some("press") => {
            let id = match arg(1) {
                Some("confirm" | "0") => 0,
                Some("up" | "1") => 1,
                Some("down" | "2") => 2,
                Some(k) if k.len() == 2 && k.starts_with('s') && (b'1'..=b'8').contains(&k.as_bytes()[1]) => {
                    PANEL_KEY_FIRST + (k.as_bytes()[1] - b'1')
                }
                _ => usage(),
            };
            request("press", json!({"id": id, "pressed": true}))
                .and_then(|_| request("press", json!({"id": id, "pressed": false})))
                .map(|_| ())
        }
        Some("bench") => {
            let n: u64 = arg(1).and_then(|c| c.parse().ok()).unwrap_or(1000);
            request("bench", json!({"n": n})).map(pretty)
        }
        Some("call") => {
            let params = arg(2).map(serde_json::from_str).transpose().unwrap_or_else(|e| {
                eprintln!("bad JSON params: {e}");
                process::exit(2)
            });
            request(arg(1).unwrap_or_else(|| usage()), params.unwrap_or_else(|| json!({}))).map(pretty)
        }
        _ => usage(),
    };
    if let Err(e) = result {
        eprintln!("qonu-link: {e}");
        process::exit(1);
    }
}
