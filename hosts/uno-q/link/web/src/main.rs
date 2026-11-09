//! qonu-web: the UNO Q's front door on the LAN (port 80).
//!
//!   /             a landing page
//!   /t/<token>    the one-time link the panel shows as a QR code: a valid token opens a session (a cookie), is
//!                 replaced at once, and redirects to /term
//!   /term         the terminal page (xterm.js), session required
//!   /term/ws      WebSocket to a login shell on a PTY, session required
//!   /term/*.js    vendored xterm.js 6.0.0 and its fit addon (MIT, assets/LICENSE.xterm)
//!
//! Who may open a terminal is decided by the panel: the token is shown only there, as a QR code; it is replaced after
//! each use and every 10 minutes, and written to /run/qonu/web.json (root only) for qonu-dash to draw. A session lasts
//! 12 hours and lives in this process only. HTTP is plain (no TLS) and meant for the home LAN.
use std::collections::HashMap;
use std::ffi::CString;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::json;
use tungstenite::protocol::frame::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{Role, WebSocket};
use tungstenite::{Error as WsError, Message};

const STATE_FILE: &str = "/run/qonu/web.json";
const APPS_FILE: &str = "/data/fractonica/home/apps/apps.json";
const TOKEN_TTL: Duration = Duration::from_secs(600);
const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);
const MAX_HEAD: usize = 16 * 1024;

/// SIGUSR1 (`systemctl kill -s USR1 qonu-web`, the CONTROL page's confirm button) asks for a new code now.
static ROTATE_NOW: AtomicBool = AtomicBool::new(false);
extern "C" fn on_usr1(_: libc::c_int) {
    ROTATE_NOW.store(true, Ordering::Relaxed);
}

const XTERM_JS: &[u8] = include_bytes!("../assets/xterm.js");
const XTERM_CSS: &[u8] = include_bytes!("../assets/xterm.css");
const FIT_JS: &[u8] = include_bytes!("../assets/addon-fit.js");
const TERM_HTML: &str = include_str!("../assets/term.html");

// ------------------------------------------------------------------ state

struct Auth {
    port: u16,
    token: String,
    token_until: Instant,
    sessions: HashMap<String, Instant>,
}

type Shared = Arc<Mutex<Auth>>;

fn random_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("/dev/urandom");
    b
}

/// 12 characters of [A-Za-z0-9]: about 71 bits.
fn new_token() -> String {
    const ALPHA: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    random_bytes(12).iter().map(|b| ALPHA[*b as usize % ALPHA.len()] as char).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Replaces the token and publishes it for qonu-dash.
fn rotate(a: &mut Auth) {
    a.token = new_token();
    a.token_until = Instant::now() + TOKEN_TTL;
    let expires_s = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) + TOKEN_TTL.as_secs();
    let text = json!({"port": a.port, "token": a.token, "expires_s": expires_s, "path": format!("/t/{}", a.token)});
    let tmp = format!("{STATE_FILE}.tmp");
    let ok = fs::create_dir_all("/run/qonu")
        .and_then(|_| fs::write(&tmp, format!("{text}\n")))
        .and_then(|_| fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)))
        .and_then(|_| fs::rename(&tmp, STATE_FILE));
    if let Err(e) = ok {
        eprintln!("qonu-web: cannot write {STATE_FILE}: {e}");
    }
}

/// Constant-time comparison (the token is a secret).
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn session_ok(auth: &Shared, cookie: Option<&str>) -> bool {
    let Some(id) = cookie.and_then(|c| c.split(';').map(str::trim).find_map(|kv| kv.strip_prefix("qonu_session="))) else {
        return false;
    };
    let mut a = auth.lock().unwrap();
    let now = Instant::now();
    a.sessions.retain(|_, until| *until > now);
    a.sessions.keys().any(|k| same(k, id))
}

// ------------------------------------------------------------------- http

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
}

fn read_head(s: &mut TcpStream) -> io::Result<Request> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = s.read(&mut chunk)?;
        if n == 0 || buf.len() + n > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad request head"));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let path = first.next().unwrap_or_default().to_string();
    let headers = lines
        .take_while(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Ok(Request { method, path, headers })
}

fn respond(s: &mut TcpStream, status: &str, ctype: &str, extra: &[(&str, String)], body: &[u8]) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n",
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes())?;
    s.write_all(body)
}

fn hostname() -> String {
    fs::read_to_string("/proc/sys/kernel/hostname").map(|h| h.trim().to_string()).unwrap_or_else(|_| "qonu".into())
}

fn page(title: &str, body: &str) -> Vec<u8> {
    format!(
        "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width, initial-scale=1'>\
         <title>{title}</title><style>body{{margin:0;padding:24px;background:#0b0f17;color:#e5e7eb;\
         font:16px system-ui,sans-serif}}h1{{font-size:20px}}h2{{font-size:16px;margin-top:20px}}p{{color:#8b95a5;line-height:1.5}}\
         ul{{padding-left:18px}}li{{margin:6px 0}}a{{color:#60a5fa}}span{{color:#8b95a5}}</style>\
         <h1>{title}</h1>{body}</html>"
    )
    .into_bytes()
}

fn handle(mut s: TcpStream, auth: Shared) -> io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    let req = read_head(&mut s)?;
    let peer = s.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let host = hostname();
    if req.method != "GET" {
        return respond(&mut s, "405 Method Not Allowed", "text/plain", &[], b"GET only\n");
    }
    let path = req.path.split('?').next().unwrap_or("/");
    let cookie = req.headers.get("cookie").map(String::as_str);
    match path {
        "/" => {
            // The websites the hub runs (fr app deploy, kind web): FR_HOME/apps/apps.json, linked on this page's own
            // host name or address, so a phone follows them the way it came.
            let at = req.headers.get("host").map(|h| h.split(':').next().unwrap_or("").to_string()).unwrap_or_default();
            let apps: Vec<serde_json::Value> = fs::read_to_string(APPS_FILE)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| v["apps"].as_array().cloned())
                .unwrap_or_default();
            let esc = |t: &str| t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
            let mut list = String::new();
            for a in &apps {
                let name = esc(a["name"].as_str().unwrap_or("?"));
                let what = esc(a["description"].as_str().unwrap_or(""));
                match a["port"].as_u64() {
                    Some(port) if a["kind"] == "web" => list.push_str(&format!(
                        "<li><a href=\"http://{at}:{port}/\">{name}</a> <span>{what}</span></li>"
                    )),
                    _ => list.push_str(&format!("<li>{name} <span>(worker) {what}</span></li>")),
                }
            }
            let apps_html = if list.is_empty() {
                "<p>No apps yet: <code>fr app deploy &lt;folder&gt;</code> from the Mac.</p>".to_string()
            } else {
                format!("<h2>Apps</h2><ul>{list}</ul>")
            };
            respond(
                &mut s,
                "200 OK",
                "text/html; charset=utf-8",
                &[("Cache-Control", "no-store".into())],
                &page(&host, &format!(
                    "{apps_html}<p>For a terminal, open the <b>control</b> page on the display and scan its QR code.</p>"
                )),
            )
        }
        "/term/xterm.js" => respond(&mut s, "200 OK", "text/javascript", &[("Cache-Control", "max-age=86400".into())], XTERM_JS),
        "/term/addon-fit.js" => respond(&mut s, "200 OK", "text/javascript", &[("Cache-Control", "max-age=86400".into())], FIT_JS),
        "/term/xterm.css" => respond(&mut s, "200 OK", "text/css", &[("Cache-Control", "max-age=86400".into())], XTERM_CSS),
        "/term" => {
            if session_ok(&auth, cookie) {
                let html = TERM_HTML.replace("{{HOST}}", &host);
                respond(&mut s, "200 OK", "text/html; charset=utf-8", &[("Cache-Control", "no-store".into())], html.as_bytes())
            } else {
                respond(&mut s, "401 Unauthorized", "text/html; charset=utf-8", &[],
                    &page("Scan the QR code", "<p>Open the <b>control</b> page on the board's display and scan its QR \
                           code: each code opens one session.</p>"))
            }
        }
        "/term/ws" => {
            let origin_ok = match (req.headers.get("origin"), req.headers.get("host")) {
                (Some(o), Some(h)) => o.split("://").nth(1) == Some(h.as_str()),
                (None, _) => true, // not a browser
                _ => false,
            };
            let key = req.headers.get("sec-websocket-key").cloned().unwrap_or_default();
            if key.is_empty() || !origin_ok {
                return respond(&mut s, "400 Bad Request", "text/plain", &[], b"WebSocket from this page only\n");
            }
            let mut sha = sha1_smol::Sha1::new();
            sha.update(key.as_bytes());
            sha.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
            let accept = base64::engine::general_purpose::STANDARD.encode(sha.digest().bytes());
            s.write_all(
                format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n")
                    .as_bytes(),
            )?;
            s.set_read_timeout(None)?;
            let mut ws = WebSocket::from_raw_socket(s, Role::Server, None);
            if !session_ok(&auth, cookie) {
                let _ = ws.close(Some(CloseFrame { code: CloseCode::from(4401), reason: "session expired".into() }));
                let _ = ws.flush();
                return Ok(());
            }
            eprintln!("qonu-web: terminal opened from {peer}");
            let r = shell(ws);
            eprintln!("qonu-web: terminal from {peer} closed{}", r.err().map(|e| format!(": {e}")).unwrap_or_default());
            Ok(())
        }
        p if p.starts_with("/t/") => {
            let given = &p[3..];
            let mut a = auth.lock().unwrap();
            if same(given, &a.token) && Instant::now() < a.token_until {
                let id = hex(&random_bytes(16));
                a.sessions.insert(id.clone(), Instant::now() + SESSION_TTL);
                rotate(&mut a); // one use per code
                drop(a);
                eprintln!("qonu-web: session opened from {peer}");
                respond(&mut s, "303 See Other", "text/plain", &[
                    ("Location", "/term".into()),
                    ("Set-Cookie", format!("qonu_session={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}", SESSION_TTL.as_secs())),
                    ("Cache-Control", "no-store".into()),
                ], b"")
            } else {
                drop(a);
                eprintln!("qonu-web: stale or wrong link from {peer}");
                respond(&mut s, "403 Forbidden", "text/html; charset=utf-8", &[],
                    &page("This code was already used", "<p>Each QR code opens one session. Scan the code the \
                           board's display shows now.</p>"))
            }
        }
        _ => respond(&mut s, "404 Not Found", "text/plain", &[], b"not found\n"),
    }
}

// ------------------------------------------------------------------- pty

struct Child {
    pid: libc::pid_t,
    master: OwnedFd,
}

/// A login shell (`-sh`, as root's /etc/passwd entry has it) on a new PTY.
fn spawn_shell() -> io::Result<Child> {
    let shell = CString::new("/bin/sh").unwrap();
    let argv0 = CString::new("-sh").unwrap();
    let env: Vec<CString> = ["TERM=xterm-256color", "HOME=/root", "SHELL=/bin/sh", "USER=root", "LOGNAME=root",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"]
        .iter()
        .map(|s| CString::new(*s).unwrap())
        .collect();
    let mut envp: Vec<*const libc::c_char> = env.iter().map(|c| c.as_ptr()).collect();
    envp.push(std::ptr::null());
    let argv = [argv0.as_ptr(), std::ptr::null()];
    let home = CString::new("/root").unwrap();

    let (mut master, mut slave) = (0, 0);
    let ws = libc::winsize { ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0 };
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &ws) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        // Child: only async-signal-safe calls from here on.
        unsafe {
            libc::setsid();
            libc::ioctl(slave, libc::TIOCSCTTY, 0);
            libc::dup2(slave, 0);
            libc::dup2(slave, 1);
            libc::dup2(slave, 2);
            libc::close(master);
            if slave > 2 {
                libc::close(slave);
            }
            libc::chdir(home.as_ptr());
            libc::execve(shell.as_ptr(), argv.as_ptr(), envp.as_ptr());
            libc::_exit(127);
        }
    }
    unsafe { libc::close(slave) };
    set_nonblocking(master);
    Ok(Child { pid, master: unsafe { OwnedFd::from_raw_fd(master) } })
}

fn set_nonblocking(fd: RawFd) {
    unsafe { libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK) };
}

fn would_block(e: &WsError) -> bool {
    matches!(e, WsError::Io(io) if io.kind() == io::ErrorKind::WouldBlock)
}

/// Bridges the WebSocket and a new shell until either side ends. Binary messages are keystrokes; a text message
/// `{"cols": c, "rows": r}` resizes the terminal.
fn shell(mut ws: WebSocket<TcpStream>) -> io::Result<()> {
    let child = spawn_shell()?;
    // A few pointers before the prompt: root's home is nearly empty, and the board's own tools are not obvious.
    let banner = format!(
        "\r\n\x1b[1m{}\x1b[0m: root shell (qonu-web)\r\n\
         \x1b[2m  ls /data                board data, kept across reflashes\r\n\
         \x20 fr devices ls           Fractonica devices on this hub\r\n\
         \x20 systemctl list-units 'qonu-*' 'fractonica-*' 'fr-app-*'\r\n\
         \x20 journalctl -u qonu-node -f\r\n\
         \x20 exit                    end this session\x1b[0m\r\n\r\n",
        hostname()
    );
    let _ = ws.send(Message::binary(banner.into_bytes()));
    let sock = ws.get_ref().as_raw_fd();
    ws.get_ref().set_nonblocking(true)?;
    let master = child.master.as_raw_fd();
    let mut buf = vec![0u8; 16 * 1024];
    let mut backlog = false; // the socket did not take everything: wait for it before reading the shell again
    let result = loop {
        let mut fds = [
            libc::pollfd { fd: sock, events: libc::POLLIN | if backlog { libc::POLLOUT } else { 0 }, revents: 0 },
            libc::pollfd { fd: master, events: if backlog { 0 } else { libc::POLLIN }, revents: 0 },
        ];
        if unsafe { libc::poll(fds.as_mut_ptr(), 2, 30_000) } < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break Err(e);
        }
        // Browser -> shell (several frames may have arrived in one read).
        let mut closed = false;
        loop {
            match ws.read() {
                Ok(Message::Binary(b)) => {
                    let _ = unsafe { libc::write(master, b.as_ptr().cast(), b.len()) };
                }
                Ok(Message::Text(t)) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t.as_str()) {
                        let (c, r) = (v["cols"].as_u64().unwrap_or(0), v["rows"].as_u64().unwrap_or(0));
                        if (1..=1000).contains(&c) && (1..=1000).contains(&r) {
                            let w = libc::winsize { ws_row: r as u16, ws_col: c as u16, ws_xpixel: 0, ws_ypixel: 0 };
                            unsafe { libc::ioctl(master, libc::TIOCSWINSZ, &w) };
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    closed = true;
                    break;
                }
                Ok(_) => {}
                Err(e) if would_block(&e) => break,
                Err(_) => {
                    closed = true;
                    break;
                }
            }
        }
        if closed {
            break Ok(());
        }
        if backlog {
            match ws.flush() {
                Ok(()) => backlog = false,
                Err(e) if would_block(&e) => continue,
                Err(e) => break Err(io::Error::other(e.to_string())),
            }
        }
        // Shell -> browser.
        if fds[1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            let n = unsafe { libc::read(master, buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                let e = io::Error::last_os_error();
                if n < 0 && e.kind() == io::ErrorKind::WouldBlock {
                    continue;
                }
                // The shell exited (EIO on the master).
                let _ = ws.close(Some(CloseFrame { code: CloseCode::Normal, reason: "shell exited".into() }));
                let _ = ws.flush();
                break Ok(());
            }
            match ws.send(Message::binary(buf[..n as usize].to_vec())) {
                Ok(()) => {}
                Err(e) if would_block(&e) => backlog = true,
                Err(e) => break Err(io::Error::other(e.to_string())),
            }
        }
    };
    unsafe {
        libc::kill(-child.pid, libc::SIGHUP);
        libc::kill(child.pid, libc::SIGHUP);
    }
    for _ in 0..20 {
        if unsafe { libc::waitpid(child.pid, std::ptr::null_mut(), libc::WNOHANG) } != 0 {
            return result;
        }
        thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        libc::kill(-child.pid, libc::SIGKILL);
        libc::waitpid(child.pid, std::ptr::null_mut(), 0);
    }
    result
}

// ------------------------------------------------------------------- main

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let port: u16 = args.iter().position(|a| a == "--port").and_then(|i| args.get(i + 1)).and_then(|p| p.parse().ok()).unwrap_or(80);
    let listener = TcpListener::bind(("0.0.0.0", port)).unwrap_or_else(|e| {
        eprintln!("qonu-web: cannot listen on port {port}: {e}");
        std::process::exit(1);
    });
    let auth: Shared = Arc::new(Mutex::new(Auth { port, token: String::new(), token_until: Instant::now(), sessions: HashMap::new() }));
    rotate(&mut auth.lock().unwrap());
    eprintln!("qonu-web {} on port {port}", env!("CARGO_PKG_VERSION"));

    // An unused code is replaced every TOKEN_TTL, so a photo of the panel stops working.
    unsafe { libc::signal(libc::SIGUSR1, on_usr1 as *const () as libc::sighandler_t) };
    let rotator = auth.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        let mut a = rotator.lock().unwrap();
        if ROTATE_NOW.swap(false, Ordering::Relaxed) || Instant::now() >= a.token_until {
            rotate(&mut a);
        }
    });

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let auth = auth.clone();
        thread::spawn(move || {
            let _ = handle(stream, auth);
        });
    }
}
