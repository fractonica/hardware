//! qonu-dash: Linux vitals on the UNO Q's 320x172 SPI display.
//!
//! Samples /proc and /sys once a second and redraws the whole screen through
//! the qonu-link daemon (`draw` ops, then `present`). Redrawing everything each
//! time keeps it stateless: the picture heals by itself after an MCU reset, a
//! failsafe trip or a display reconnect. It costs about 1 KB on the link and
//! 22 ms of SPI per second.

use std::collections::{HashMap, VecDeque};
use std::ffi::CStr;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const SOCKET: &str = "/run/qonu/link.sock";
const W: i64 = 320;
const HISTORY: usize = 60;

// Palette.
const BG: &str = "#0b0f17";
const PANEL: &str = "#151b26";
const TRACK: &str = "#232c3b";
const TEXT: &str = "#e5e7eb";
const DIM: &str = "#8b95a5";
const ACCENT: &str = "#60a5fa";
const GOOD: &str = "#34d399";
const WARN: &str = "#fbbf24";
const BAD: &str = "#f87171";
const MEM: &str = "#a78bfa";

// ------------------------------------------------------------------ samples

#[derive(Clone, Copy, Default)]
struct CpuTimes {
    busy: u64,
    total: u64,
}

/// Aggregate and per-core counters from /proc/stat.
fn cpu_times() -> Vec<CpuTimes> {
    let stat = fs::read_to_string("/proc/stat").unwrap_or_default();
    stat.lines()
        .filter(|l| l.starts_with("cpu"))
        .map(|l| {
            let v: Vec<u64> = l.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
            let total: u64 = v.iter().take(8).sum(); // user..steal; guest is already in user
            let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0); // idle + iowait
            CpuTimes { busy: total.saturating_sub(idle), total }
        })
        .collect()
}

fn usage(prev: CpuTimes, now: CpuTimes) -> f64 {
    let dt = now.total.saturating_sub(prev.total);
    if dt == 0 { 0.0 } else { 100.0 * now.busy.saturating_sub(prev.busy) as f64 / dt as f64 }
}

fn meminfo() -> (u64, u64) {
    let mut kb = HashMap::new();
    for l in fs::read_to_string("/proc/meminfo").unwrap_or_default().lines() {
        let mut it = l.split_whitespace();
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            kb.insert(k.trim_end_matches(':').to_string(), v.parse::<u64>().unwrap_or(0));
        }
    }
    let total = kb.get("MemTotal").copied().unwrap_or(0);
    (total.saturating_sub(kb.get("MemAvailable").copied().unwrap_or(total)), total)
}

/// Thermal zones by type, in degrees C.
fn temps() -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for e in fs::read_dir("/sys/class/thermal").into_iter().flatten().flatten() {
        let p = e.path();
        let t = fs::read_to_string(p.join("type")).unwrap_or_default();
        if let Ok(milli) = fs::read_to_string(p.join("temp")).unwrap_or_default().trim().parse::<f64>() {
            out.insert(t.trim().to_string(), milli / 1000.0);
        }
    }
    out
}

fn max_temp(t: &HashMap<String, f64>, prefix: &str) -> Option<f64> {
    t.iter().filter(|(k, _)| k.starts_with(prefix)).map(|(_, v)| *v).reduce(f64::max)
}

fn read_trim(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_default().trim().to_string()
}

fn disk(path: &str) -> Option<(u64, u64)> {
    let c = std::ffi::CString::new(path).ok()?;
    // SAFETY: statvfs fills the struct we pass; zeroed is a valid initial value.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let frag = s.f_frsize as u64;
    Some(((s.f_blocks - s.f_bfree) as u64 * frag, s.f_blocks as u64 * frag))
}

fn ipv4(ifname: &str) -> Option<String> {
    let mut addrs: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs/freeifaddrs pair; we only read the list in between.
    if unsafe { libc::getifaddrs(&mut addrs) } != 0 {
        return None;
    }
    let mut found = None;
    let mut cur = addrs;
    while !cur.is_null() {
        let a = unsafe { &*cur };
        cur = a.ifa_next;
        if a.ifa_addr.is_null() || unsafe { (*a.ifa_addr).sa_family } as i32 != libc::AF_INET {
            continue;
        }
        if unsafe { CStr::from_ptr(a.ifa_name) }.to_str() == Ok(ifname) {
            let sin = unsafe { &*(a.ifa_addr as *const libc::sockaddr_in) };
            found = Some(std::net::Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)).to_string());
            break;
        }
    }
    unsafe { libc::freeifaddrs(addrs) };
    found
}

fn net_bytes(ifname: &str) -> (u64, u64) {
    let r = |k| read_trim(&format!("/sys/class/net/{ifname}/statistics/{k}")).parse().unwrap_or(0);
    (r("rx_bytes"), r("tx_bytes"))
}

/// SSID and RSSI from iwd (no wireless extensions in this kernel).
fn wifi() -> (Option<String>, Option<i64>) {
    let out = Command::new("iwctl").args(["station", "wlan0", "show"]).output();
    let Ok(out) = out else { return (None, None) };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut ssid = None;
    let mut rssi = None;
    for line in text.lines() {
        // iwctl colors its output; drop escape sequences before parsing.
        let mut clean = String::new();
        let mut esc = false;
        for c in line.chars() {
            match (esc, c) {
                (false, '\x1b') => esc = true,
                (true, c) if c.is_ascii_alphabetic() => esc = false,
                (true, _) => {}
                (false, c) => clean.push(c),
            }
        }
        let clean = clean.trim();
        if let Some(v) = clean.strip_prefix("Connected network") {
            ssid = Some(v.trim().to_string());
        } else if let Some(v) = clean.strip_prefix("RSSI") {
            rssi = v.trim().trim_end_matches("dBm").trim().parse().ok();
        }
    }
    (ssid, rssi)
}

fn clock() -> String {
    // SAFETY: time/localtime_r with a zeroed tm we own.
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

// ------------------------------------------------------------------ format

fn duration(secs: u64) -> String {
    let (d, h, m) = (secs / 86400, secs / 3600 % 24, secs / 60 % 60);
    if d > 0 { format!("{d}d {h}h") } else if h > 0 { format!("{h}h {m:02}m") } else { format!("{m}m {:02}s", secs % 60) }
}

fn bytes(b: u64) -> String {
    let b = b as f64;
    if b >= 1e9 { format!("{:.1}G", b / 1e9) } else if b >= 1e6 { format!("{:.0}M", b / 1e6) } else { format!("{:.0}K", b / 1e3) }
}

fn rate(bps: f64) -> String {
    if bps >= 1e6 { format!("{:.1}MB/s", bps / 1e6) } else { format!("{:.1}KB/s", bps / 1e3) }
}

fn level(pct: f64, warn: f64, bad: f64) -> &'static str {
    if pct >= bad { BAD } else if pct >= warn { WARN } else { GOOD }
}

// ------------------------------------------------------------------- link

struct Link {
    errors_logged: Instant,
}

impl Link {
    fn call(&mut self, method: &str, params: Value) -> Option<Value> {
        let r = (|| -> Result<Value, String> {
            let mut s = UnixStream::connect(SOCKET).map_err(|e| e.to_string())?;
            s.set_read_timeout(Some(Duration::from_secs(2))).ok();
            writeln!(s, "{}", json!({"id": 1, "method": method, "params": params})).map_err(|e| e.to_string())?;
            let mut line = String::new();
            BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if v["ok"] == true { Ok(v["result"].clone()) } else { Err(v["error"].as_str().unwrap_or("?").to_string()) }
        })();
        match r {
            Ok(v) => Some(v),
            Err(e) => {
                // At most one log line a minute while the daemon or MCU is away.
                if self.errors_logged.elapsed() > Duration::from_secs(60) {
                    eprintln!("qonu-dash: {method}: {e}");
                    self.errors_logged = Instant::now();
                }
                None
            }
        }
    }
}

// ------------------------------------------------------------------- draw

struct Ops(Vec<Value>);

impl Ops {
    fn text(&mut self, x: i64, y: i64, font: &str, color: &str, align: &str, text: impl Into<String>) {
        let mut t: String = text.into();
        while t.len() > 64 {
            t.pop();
        }
        self.0.push(json!({"op": "text", "x": x, "y": y, "font": font, "color": color, "align": align, "text": t}));
    }
    fn rect(&mut self, x: i64, y: i64, w: i64, h: i64, color: &str) {
        self.0.push(json!({"op": "rect", "x": x, "y": y, "w": w.max(0), "h": h.max(0), "color": color, "filled": true}));
    }
    /// Horizontal gauge: track plus a filled share.
    fn gauge(&mut self, x: i64, y: i64, w: i64, h: i64, pct: f64, color: &str) {
        self.rect(x, y, w, h, TRACK);
        self.rect(x, y, (w as f64 * pct.clamp(0.0, 100.0) / 100.0).round() as i64, h, color);
    }
}

struct State {
    prev_cpu: Vec<CpuTimes>,
    history: VecDeque<f64>,
    prev_net: (u64, u64),
    prev_at: Instant,
    wifi: (Option<String>, Option<i64>),
    wifi_at: Option<Instant>,
    mcu: Option<Value>,
    mcu_at: Option<Instant>,
}

fn frame(st: &mut State, link: &mut Link) -> Vec<Value> {
    // --- sample
    let cpu = cpu_times();
    let per: Vec<f64> = cpu.iter().zip(st.prev_cpu.iter()).map(|(n, p)| usage(*p, *n)).collect();
    st.prev_cpu = cpu;
    let total = per.first().copied().unwrap_or(0.0);
    let cores = per.get(1..).unwrap_or(&[]).to_vec();
    if st.history.len() == HISTORY {
        st.history.pop_front();
    }
    st.history.push_back(total);

    let (mem_used, mem_total) = meminfo();
    let t = temps();
    let load = read_trim("/proc/loadavg");
    let load: Vec<&str> = load.split_whitespace().collect();
    let uptime = read_trim("/proc/uptime").split_whitespace().next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);

    let now = Instant::now();
    let dt = now.duration_since(st.prev_at).as_secs_f64().max(0.001);
    let net = net_bytes("wlan0");
    let (rx, tx) = ((net.0.saturating_sub(st.prev_net.0)) as f64 / dt, (net.1.saturating_sub(st.prev_net.1)) as f64 / dt);
    st.prev_net = net;
    st.prev_at = now;

    if st.wifi_at.is_none_or(|t| t.elapsed() > Duration::from_secs(10)) {
        st.wifi = wifi();
        st.wifi_at = Some(Instant::now());
    }
    if st.mcu_at.is_none_or(|t| t.elapsed() > Duration::from_secs(5)) {
        st.mcu = link.call("info", json!({}));
        st.mcu_at = Some(Instant::now());
    }
    let stats = link.call("stats", json!({}));

    // --- layout, 320 x 172
    let mut o = Ops(vec![json!({"op": "clear", "color": BG})]);

    // Header
    o.rect(0, 0, W, 19, PANEL);
    o.text(6, 3, "medium", TEXT, "left", read_trim("/proc/sys/kernel/hostname"));
    o.text(W / 2, 3, "medium", ACCENT, "center", clock());
    o.text(W - 6, 5, "small", DIM, "right", format!("up {}", duration(uptime as u64)));

    // CPU: big number, per-core bars, 60 s history
    o.text(6, 24, "small", DIM, "left", "CPU");
    o.text(6, 34, "huge", level(total, 50.0, 85.0), "left", format!("{:.0}%", total));
    o.0.push(json!({"op": "bars", "x": 76, "y": 36, "h": 30, "bar_w": 6, "gap": 3, "color": ACCENT, "bg": TRACK,
        "values": cores.iter().map(|v| v.round()).collect::<Vec<_>>()}));
    o.text(116, 24, "small", DIM, "left", format!("load {}", load.get(..3).map(|l| l.join(" ")).unwrap_or_default()));
    let hist: Vec<f64> = st.history.iter().map(|v| v.round()).collect();
    let hx = W - 6 - (HISTORY as i64) * 3 + 1;
    o.0.push(json!({"op": "bars", "x": hx, "y": 36, "h": 30, "bar_w": 2, "gap": 1, "color": GOOD, "bg": PANEL, "values": hist}));

    // Memory
    let mem_pct = if mem_total > 0 { 100.0 * mem_used as f64 / mem_total as f64 } else { 0.0 };
    o.text(6, 74, "small", DIM, "left", "MEM");
    o.gauge(40, 75, 150, 9, mem_pct, MEM);
    o.text(196, 74, "small", TEXT, "left", format!("{}/{} MB {:.0}%", mem_used / 1024, mem_total / 1024, mem_pct));

    // Temperatures
    o.text(6, 91, "small", DIM, "left", "TEMP");
    let mut x = 40;
    for (label, prefix) in [("CPU", "cpuss"), ("GPU", "gpu"), ("WLAN", "wlan"), ("MDM", "mdm")] {
        if let Some(c) = max_temp(&t, prefix) {
            o.text(x, 89, "medium", level(c, 60.0, 80.0), "left", format!("{label} {c:.0}°"));
            x += 8 * (label.len() as i64 + 5) + 4;
        }
    }

    // Disk
    o.text(6, 108, "small", DIM, "left", "DISK");
    let mut parts = vec![];
    for (name, path) in [("/", "/"), ("/data", "/data")] {
        if let Some((used, size)) = disk(path) {
            parts.push(format!("{name} {}/{} {:.0}%", bytes(used), bytes(size), 100.0 * used as f64 / size.max(1) as f64));
        }
    }
    o.text(40, 108, "small", TEXT, "left", parts.join("   "));

    // Network
    o.text(6, 124, "small", DIM, "left", "WIFI");
    let (ssid, rssi) = &st.wifi;
    let rssi_color = match rssi {
        Some(r) if *r >= -60 => GOOD,
        Some(r) if *r >= -72 => WARN,
        Some(_) => BAD,
        None => DIM,
    };
    o.text(40, 124, "small", TEXT, "left", ssid.clone().unwrap_or_else(|| "not connected".into()));
    if let Some(r) = rssi {
        o.text(W - 6, 124, "small", rssi_color, "right", format!("{r} dBm"));
    }
    o.text(40, 137, "small", DIM, "left", format!(
        "{}  rx {}  tx {}",
        ipv4("wlan0").unwrap_or_else(|| "-".into()),
        rate(rx),
        rate(tx)
    ));

    // Footer: the MCU link
    o.rect(0, 153, W, 19, PANEL);
    let link_up = stats.as_ref().is_some_and(|s| s["link_up"] == true);
    if link_up {
        let s = stats.as_ref().unwrap();
        let fw = st.mcu.as_ref().and_then(|i| i["fw"].as_array().cloned()).map(|v| {
            v.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(".")
        });
        let c = &s["counters"];
        let errs: u64 = ["rx_bad_crc", "rx_bad_frame", "timeouts"].iter().filter_map(|k| c[k].as_u64()).sum();
        let rtt = s["rtt_us"]["p50"].as_u64().map(|us| format!("{:.2} ms", us as f64 / 1000.0)).unwrap_or("-".into());
        o.text(6, 157, "small", DIM, "left", format!(
            "STM32 fw {}  link {}  {} err  {}",
            fw.unwrap_or_else(|| "?".into()),
            rtt,
            errs,
            s["failsafe"].as_str().unwrap_or("?")
        ));
        o.rect(W - 14, 158, 8, 8, GOOD);
    } else {
        o.text(6, 157, "small", BAD, "left", "STM32 link down");
        o.rect(W - 14, 158, 8, 8, BAD);
    }

    o.0.push(json!({"op": "present"}));
    o.0
}

fn main() {
    let interval = std::env::args()
        .skip_while(|a| a != "--interval-ms")
        .nth(1)
        .and_then(|v| v.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(1));
    let once = std::env::args().any(|a| a == "--once");
    let mut link = Link { errors_logged: Instant::now() - Duration::from_secs(120) };
    let mut st = State {
        prev_cpu: cpu_times(),
        history: VecDeque::with_capacity(HISTORY),
        prev_net: net_bytes("wlan0"),
        prev_at: Instant::now(),
        wifi: (None, None),
        wifi_at: None,
        mcu: None,
        mcu_at: None,
    };
    eprintln!("qonu-dash {}: every {} ms", env!("CARGO_PKG_VERSION"), interval.as_millis());
    let mut next = Instant::now() + Duration::from_millis(300); // first CPU delta
    loop {
        thread::sleep(next.saturating_duration_since(Instant::now()));
        next += interval;
        let ops = frame(&mut st, &mut link);
        link.call("draw", json!({"ops": ops}));
        if once {
            break;
        }
    }
}
