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
//! Methods: ping, info, stats, led {r,g,b}, clear_failsafe, bench {n}, fault {kind}.

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
    self as proto, Accumulator, ErrorCode, Event, FailsafeState, Fault, FrameError, MAX_FRAME, Request, Response, Up,
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
            }
            Up::Event(Event::Failsafe { state }) => {
                eprintln!("mcu: failsafe {state:?}");
                if state == FailsafeState::Tripped {
                    self.stat(|s| s.failsafe_trips += 1);
                }
                *self.failsafe.lock().unwrap() = Some(state);
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
            Ok(req) => dispatch(link, &req),
            Err(e) => json!({"id": null, "ok": false, "error": format!("bad JSON: {e}")}),
        };
        writeln!(out, "{reply}")?;
    }
    Ok(())
}

fn expect_ok(r: Result<Response, CallError>) -> Result<Value, String> {
    match r {
        Ok(Response::Ok) => Ok(json!("ok")),
        Ok(Response::Error(code)) => Err(format!("MCU refused: {code:?}")),
        Ok(other) => Err(format!("unexpected answer: {other:?}")),
        Err(e) => Err(e.to_string()),
    }
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
            match link.call(&Request::Ping { nonce }) {
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
       qonu-link clear              leave a latched failsafe
       qonu-link bench [N]          N back-to-back pings, latency percentiles
       qonu-link fault hang|panic   break the firmware on purpose to test recovery
       qonu-link call METHOD [JSON] raw socket request"
    );
    process::exit(2)
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
        Some("clear") => request("clear_failsafe", json!({})).map(pretty),
        Some("led") => {
            let on = |i| arg(i) == Some("1");
            request("led", json!({"r": on(1), "g": on(2), "b": on(3)})).map(pretty)
        }
        Some("fault") => request("fault", json!({"kind": arg(1).unwrap_or("")})).map(pretty),
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
