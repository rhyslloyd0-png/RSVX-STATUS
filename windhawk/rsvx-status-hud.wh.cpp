// ==WindhawkMod==
// @id              rsvx-status-hud
// @name            RSVX Status HUD
// @description     Click-through overlay for the RSVX Status board: overall state, VPS load and services. Grows to show what failed when a check goes down.
// @version         1.0
// @author          RSVX Developments
// @github          https://github.com/rhyslloyd0-png
// @homepage        https://rsvx.co.uk
// @include         explorer.exe
// @compilerOptions -lwinhttp -lgdiplus -lgdi32 -luser32
// ==/WindhawkMod==

// ==WindhawkModReadme==
/*
# RSVX Status HUD

A small overlay in the corner of the screen that reads your RSVX Status board
and shows:

- one line saying whether everything is running
- CPU, RAM and disk of the server
- the services the board watches (FiveM, txAdmin, MariaDB and so on)

While everything passes it stays a compact strip. When a check fails it grows
and lists what failed and why, then shrinks again once it recovers. If the
board itself stops answering, the HUD says so.

The mouse passes straight through it, and it stays above other windows,
including games running in borderless or windowed mode. Exclusive fullscreen
games draw over everything, so switch those to borderless.

**Ctrl+Alt+F9** hides and shows it.

## Setup

Open the Settings tab and fill in the board address (for example
`http://203.0.113.10:8787`) and the same password you use to open the status
page. The password is kept in Windhawk's settings on this PC.

Contact: rhys@rsvx.co.uk
*/
// ==/WindhawkModReadme==

// ==WindhawkModSettings==
/*
- boardUrl: "http://your-server:8787"
  $name: Board address
  $description: Where the RSVX Status page lives, including the port.
- password: ""
  $name: Board password
  $description: The STATUS_PASSWORD from the board's .env. Leave empty if the board has none.
- corner: topRight
  $name: Corner
  $options:
  - topLeft: Top left
  - topRight: Top right
  - bottomLeft: Bottom left
  - bottomRight: Bottom right
- offsetX: 16
  $name: Distance from the side edge
- offsetY: 16
  $name: Distance from the top or bottom edge
- opacity: 88
  $name: Opacity (20 to 100)
- scale: 100
  $name: Size (percent)
- refreshSeconds: 30
  $name: Seconds between updates
- showBars: true
  $name: Show CPU, RAM and disk
- showServices: true
  $name: Show services
- maxFailures: 6
  $name: Most failures to list
- hotkey: true
  $name: Ctrl+Alt+F9 hides and shows the HUD
*/
// ==/WindhawkModSettings==

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

#ifdef NOMINMAX
namespace Gdiplus {
using std::max;
using std::min;
}  // namespace Gdiplus
#endif
#include <gdiplus.h>

// ---------------------------------------------------------------------------
// Settings

struct Settings {
    std::wstring boardUrl;
    std::wstring password;
    std::wstring corner;
    int offsetX = 16;
    int offsetY = 16;
    int opacity = 88;
    int scale = 100;
    int refreshSeconds = 30;
    bool showBars = true;
    bool showServices = true;
    int maxFailures = 6;
    bool hotkey = true;
};

static Settings g_settings;

static std::wstring StringSetting(PCWSTR name) {
    PCWSTR value = Wh_GetStringSetting(name);
    std::wstring out = value ? value : L"";
    Wh_FreeStringSetting(value);
    return out;
}

static void LoadSettings() {
    Settings s;
    s.boardUrl = StringSetting(L"boardUrl");
    s.password = StringSetting(L"password");
    s.corner = StringSetting(L"corner");
    s.offsetX = std::clamp(Wh_GetIntSetting(L"offsetX"), 0, 4000);
    s.offsetY = std::clamp(Wh_GetIntSetting(L"offsetY"), 0, 4000);
    s.opacity = std::clamp(Wh_GetIntSetting(L"opacity"), 20, 100);
    s.scale = std::clamp(Wh_GetIntSetting(L"scale"), 60, 250);
    s.refreshSeconds = std::clamp(Wh_GetIntSetting(L"refreshSeconds"), 5, 3600);
    s.showBars = Wh_GetIntSetting(L"showBars") != 0;
    s.showServices = Wh_GetIntSetting(L"showServices") != 0;
    s.maxFailures = std::clamp(Wh_GetIntSetting(L"maxFailures"), 1, 15);
    s.hotkey = Wh_GetIntSetting(L"hotkey") != 0;
    while (!s.boardUrl.empty() && (s.boardUrl.back() == L'/' || s.boardUrl.back() == L' ')) {
        s.boardUrl.pop_back();
    }
    g_settings = s;
}

// ---------------------------------------------------------------------------
// A small JSON reader. The board's answer is the only thing it ever parses.

struct JVal {
    enum Type { Null, Bool, Num, Str, Arr, Obj };
    Type type = Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<JVal> items;         // array items, or object values
    std::vector<std::string> keys;   // object keys, same order as items

    const JVal* Get(const char* key) const {
        if (type != Obj) return nullptr;
        for (size_t i = 0; i < keys.size(); i++) {
            if (keys[i] == key) return &items[i];
        }
        return nullptr;
    }
    std::string Text(const char* key) const {
        const JVal* v = Get(key);
        return v && v->type == Str ? v->s : std::string();
    }
    double Number(const char* key, double fallback = 0) const {
        const JVal* v = Get(key);
        return v && v->type == Num ? v->n : fallback;
    }
};

class JsonReader {
   public:
    explicit JsonReader(const std::string& text) : p_(text.data()), end_(text.data() + text.size()) {}

    bool Parse(JVal& out) {
        if (!Value(out, 0)) return false;
        Space();
        return p_ == end_;
    }

   private:
    const char* p_;
    const char* end_;

    void Space() {
        while (p_ < end_ && (*p_ == ' ' || *p_ == '\n' || *p_ == '\r' || *p_ == '\t')) p_++;
    }

    bool Word(const char* w) {
        size_t len = strlen(w);
        if ((size_t)(end_ - p_) < len || memcmp(p_, w, len) != 0) return false;
        p_ += len;
        return true;
    }

    static void AppendUtf8(std::string& s, unsigned cp) {
        if (cp < 0x80) {
            s += (char)cp;
        } else if (cp < 0x800) {
            s += (char)(0xC0 | (cp >> 6));
            s += (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            s += (char)(0xE0 | (cp >> 12));
            s += (char)(0x80 | ((cp >> 6) & 0x3F));
            s += (char)(0x80 | (cp & 0x3F));
        } else {
            s += (char)(0xF0 | (cp >> 18));
            s += (char)(0x80 | ((cp >> 12) & 0x3F));
            s += (char)(0x80 | ((cp >> 6) & 0x3F));
            s += (char)(0x80 | (cp & 0x3F));
        }
    }

    bool Hex4(unsigned& out) {
        if (end_ - p_ < 4) return false;
        out = 0;
        for (int i = 0; i < 4; i++) {
            char c = *p_++;
            out <<= 4;
            if (c >= '0' && c <= '9') out |= (unsigned)(c - '0');
            else if (c >= 'a' && c <= 'f') out |= (unsigned)(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') out |= (unsigned)(c - 'A' + 10);
            else return false;
        }
        return true;
    }

    bool String(std::string& out) {
        if (p_ >= end_ || *p_ != '"') return false;
        p_++;
        while (p_ < end_) {
            char c = *p_++;
            if (c == '"') return true;
            if (c != '\\') {
                out += c;
                continue;
            }
            if (p_ >= end_) return false;
            char e = *p_++;
            switch (e) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'u': {
                    unsigned cp;
                    if (!Hex4(cp)) return false;
                    if (cp >= 0xD800 && cp < 0xDC00 && end_ - p_ >= 6 && p_[0] == '\\' && p_[1] == 'u') {
                        p_ += 2;
                        unsigned low;
                        if (!Hex4(low)) return false;
                        if (low >= 0xDC00 && low < 0xE000) cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                        else cp = 0xFFFD;
                    }
                    AppendUtf8(out, cp);
                    break;
                }
                default: out += e; break;  // \" \\ \/
            }
        }
        return false;
    }

    bool Value(JVal& out, int depth) {
        if (depth > 24) return false;
        Space();
        if (p_ >= end_) return false;
        char c = *p_;
        if (c == '{') {
            p_++;
            out.type = JVal::Obj;
            Space();
            if (p_ < end_ && *p_ == '}') { p_++; return true; }
            for (;;) {
                Space();
                std::string key;
                if (!String(key)) return false;
                Space();
                if (p_ >= end_ || *p_++ != ':') return false;
                JVal v;
                if (!Value(v, depth + 1)) return false;
                out.keys.push_back(std::move(key));
                out.items.push_back(std::move(v));
                Space();
                if (p_ >= end_) return false;
                if (*p_ == ',') { p_++; continue; }
                if (*p_ == '}') { p_++; return true; }
                return false;
            }
        }
        if (c == '[') {
            p_++;
            out.type = JVal::Arr;
            Space();
            if (p_ < end_ && *p_ == ']') { p_++; return true; }
            for (;;) {
                JVal v;
                if (!Value(v, depth + 1)) return false;
                out.items.push_back(std::move(v));
                Space();
                if (p_ >= end_) return false;
                if (*p_ == ',') { p_++; continue; }
                if (*p_ == ']') { p_++; return true; }
                return false;
            }
        }
        if (c == '"') {
            out.type = JVal::Str;
            return String(out.s);
        }
        if (Word("true")) { out.type = JVal::Bool; out.b = true; return true; }
        if (Word("false")) { out.type = JVal::Bool; return true; }
        if (Word("null")) return true;

        const char* start = p_;
        while (p_ < end_ && (isdigit((unsigned char)*p_) || *p_ == '-' || *p_ == '+' || *p_ == '.' || *p_ == 'e' || *p_ == 'E')) p_++;
        if (p_ == start) return false;
        out.type = JVal::Num;
        out.n = strtod(std::string(start, p_).c_str(), nullptr);
        return true;
    }
};

static std::wstring Wide(const std::string& utf8) {
    if (utf8.empty()) return std::wstring();
    int len = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), (int)utf8.size(), nullptr, 0);
    std::wstring out((size_t)len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), (int)utf8.size(), out.data(), len);
    return out;
}

static std::string Utf8(const std::wstring& wide) {
    if (wide.empty()) return std::string();
    int len = WideCharToMultiByte(CP_UTF8, 0, wide.data(), (int)wide.size(), nullptr, 0, nullptr, nullptr);
    std::string out((size_t)len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.data(), (int)wide.size(), out.data(), len, nullptr, nullptr);
    return out;
}

// ---------------------------------------------------------------------------
// What the HUD shows

enum class State { Ok, Warn, Down, Pending, Idle };

static State StateOf(const std::string& s) {
    if (s == "ok") return State::Ok;
    if (s == "warn") return State::Warn;
    if (s == "down") return State::Down;
    if (s == "pending") return State::Pending;
    return State::Idle;
}

struct Bar {
    std::wstring label;
    double value = 0;
};

struct Row {
    std::wstring name;
    std::wstring summary;
    std::wstring group;
    State state = State::Idle;
};

struct Board {
    bool loaded = false;   // at least one good answer since the mod started
    bool ready = false;    // the board has finished its first round of checks
    int live = 0;          // checks that are switched on
    int bad = 0;           // of those, how many are down or need attention
    State overall = State::Idle;
    std::vector<Bar> bars;
    std::vector<Row> services;
    std::vector<Row> failures;
};

static Board g_board;
static std::wstring g_error;  // why the last update failed, empty when it worked

static const wchar_t* GroupLabel(const std::string& g) {
    if (g == "vps") return L"VPS";
    if (g == "render") return L"RENDER";
    if (g == "github") return L"GITHUB";
    if (g == "sites") return L"WEB";
    return L"";
}

static bool ReadBoard(const std::string& json, Board& out) {
    JVal root;
    if (!JsonReader(json).Parse(root) || root.type != JVal::Obj) return false;
    const JVal* checks = root.Get("checks");
    if (!checks || checks->type != JVal::Arr) return false;

    Board b;
    b.loaded = true;
    const JVal* ready = root.Get("ready");
    b.ready = ready && ready->type == JVal::Bool && ready->b;

    bool anyDown = false;
    for (const JVal& c : checks->items) {
        if (c.type != JVal::Obj) continue;
        State st = StateOf(c.Text("status"));
        std::string group = c.Text("group");
        std::string kind = c.Text("kind");

        if (st != State::Idle) b.live++;
        if (st == State::Down || st == State::Warn) {
            b.bad++;
            anyDown = anyDown || st == State::Down;
            b.failures.push_back({Wide(c.Text("name")), Wide(c.Text("summary")), GroupLabel(group), st});
        }

        if (group == "vps" && kind == "service") {
            b.services.push_back({Wide(c.Text("name")), L"", L"", st});
        }
        if (group == "vps" && kind == "host") {
            const JVal* bars = c.Get("bars");
            if (bars && bars->type == JVal::Arr) {
                for (const JVal& bar : bars->items) {
                    if (bar.type != JVal::Obj) continue;
                    double v = bar.Number("value");
                    if (!(v >= 0)) v = 0;  // also catches NaN
                    b.bars.push_back({Wide(bar.Text("label")), std::min(v, 100.0)});
                }
            }
        }
    }
    // The board lists failures first already; keep "down" above "needs attention".
    std::stable_sort(b.failures.begin(), b.failures.end(),
                     [](const Row& x, const Row& y) { return x.state == State::Down && y.state != State::Down; });
    std::sort(b.services.begin(), b.services.end(), [](const Row& x, const Row& y) {
        return _wcsicmp(x.name.c_str(), y.name.c_str()) < 0;
    });
    b.overall = !b.ready ? State::Pending : anyDown ? State::Down : b.bad ? State::Warn : State::Ok;
    out = std::move(b);
    return true;
}

// ---------------------------------------------------------------------------
// Talking to the board

struct BoardUrl {
    bool https = false;
    std::wstring host;
    INTERNET_PORT port = 0;
    std::wstring basePath;
};

static bool ParseBoardUrl(const std::wstring& text, BoardUrl& out) {
    if (text.empty() || text.find(L"your-server") != std::wstring::npos) return false;
    URL_COMPONENTS uc = {};
    uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = {};
    wchar_t path[1024] = {};
    uc.lpszHostName = host;
    uc.dwHostNameLength = ARRAYSIZE(host);
    uc.lpszUrlPath = path;
    uc.dwUrlPathLength = ARRAYSIZE(path);
    if (!WinHttpCrackUrl(text.c_str(), (DWORD)text.size(), 0, &uc)) return false;
    if (uc.nScheme != INTERNET_SCHEME_HTTP && uc.nScheme != INTERNET_SCHEME_HTTPS) return false;
    out.https = uc.nScheme == INTERNET_SCHEME_HTTPS;
    out.host = host;
    out.port = uc.nPort;
    out.basePath = path;
    while (!out.basePath.empty() && out.basePath.back() == L'/') out.basePath.pop_back();
    return !out.host.empty();
}

struct HttpResult {
    bool reached = false;  // false: no answer at all
    DWORD status = 0;
    std::string body;
    std::string cookie;    // "rsvx_status=..." if the answer set one
};

static HttpResult Http(const BoardUrl& url, PCWSTR verb, PCWSTR path, const std::string& cookie, const std::string& form) {
    HttpResult r;
    HINTERNET session = WinHttpOpen(L"RSVX-Status-HUD/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
                                    WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return r;
    // Short timeouts: unloading the mod has to wait for a request in flight.
    WinHttpSetTimeouts(session, 3000, 3000, 3000, 5000);

    HINTERNET connect = WinHttpConnect(session, url.host.c_str(), url.port, 0);
    HINTERNET request = nullptr;
    if (connect) {
        std::wstring full = url.basePath + path;
        request = WinHttpOpenRequest(connect, verb, full.c_str(), nullptr, WINHTTP_NO_REFERER,
                                     WINHTTP_DEFAULT_ACCEPT_TYPES, url.https ? WINHTTP_FLAG_SECURE : 0);
    }
    if (request) {
        // The login answers with a redirect that carries the cookie, so
        // redirects must not be followed, and the cookie is handled here.
        DWORD off = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES;
        WinHttpSetOption(request, WINHTTP_OPTION_DISABLE_FEATURE, &off, sizeof(off));

        std::wstring headers;
        if (!cookie.empty()) headers += L"Cookie: " + Wide(cookie) + L"\r\n";
        if (!form.empty()) headers += L"Content-Type: application/x-www-form-urlencoded\r\n";

        BOOL ok = WinHttpSendRequest(request, headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(),
                                     headers.empty() ? 0 : (DWORD)-1L,
                                     form.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)form.data(), (DWORD)form.size(),
                                     (DWORD)form.size(), 0);
        ok = ok && WinHttpReceiveResponse(request, nullptr);
        if (ok) {
            DWORD status = 0, size = sizeof(status);
            if (WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                    WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX)) {
                r.reached = true;
                r.status = status;
            }

            for (DWORD index = 0; index < 16;) {
                wchar_t value[1024];
                DWORD len = sizeof(value);
                DWORD before = index;
                if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_SET_COOKIE, WINHTTP_HEADER_NAME_BY_INDEX, value, &len, &index)) break;
                std::wstring v(value);
                if (v.rfind(L"rsvx_status=", 0) == 0) {
                    r.cookie = Utf8(v.substr(0, v.find(L';')));
                    break;
                }
                if (index == before) break;
            }

            const size_t limit = 4 * 1024 * 1024;
            for (;;) {
                char buffer[8192];
                DWORD got = 0;
                if (!WinHttpReadData(request, buffer, sizeof(buffer), &got) || got == 0) break;
                r.body.append(buffer, got);
                if (r.body.size() > limit) break;
            }
        }
    }
    if (request) WinHttpCloseHandle(request);
    if (connect) WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return r;
}

static std::string FormEncode(const std::string& s) {
    static const char hex[] = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out += (char)c;
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 15];
        }
    }
    return out;
}

static std::string g_cookie;
static ULONGLONG g_noLoginUntil = 0;  // after a refused password, wait before trying again

// One update. Fills g_board on success, g_error on failure (g_board keeps the
// last good answer so the HUD can still show it, dimmed).
static void Update() {
    BoardUrl url;
    if (!ParseBoardUrl(g_settings.boardUrl, url)) {
        g_error = L"Set the board address in the mod settings";
        return;
    }

    HttpResult r = Http(url, L"GET", L"/api/status", g_cookie, "");
    if (r.reached && r.status == 401) {
        if (g_settings.password.empty()) {
            g_error = L"Add the board password in the mod settings";
            return;
        }
        if (GetTickCount64() < g_noLoginUntil) return;  // keep showing the last login error

        HttpResult login = Http(url, L"POST", L"/login", "", "password=" + FormEncode(Utf8(g_settings.password)));
        if (!login.reached) {
            g_error = L"The board is not answering";
            return;
        }
        if (login.cookie.empty()) {
            // The board allows 8 tries in 10 minutes, so do not hammer it.
            g_noLoginUntil = GetTickCount64() + 5 * 60 * 1000;
            g_error = login.status == 429 ? L"Too many logins, trying again in 5 min"
                                          : L"Wrong board password in the mod settings";
            Wh_Log(L"Login refused, HTTP %u", (unsigned)login.status);
            return;
        }
        g_cookie = login.cookie;
        r = Http(url, L"GET", L"/api/status", g_cookie, "");
    }

    if (!r.reached) {
        g_error = L"The board is not answering";
        return;
    }
    if (r.status != 200) {
        g_error = L"The board answered HTTP " + std::to_wstring(r.status);
        return;
    }
    if (!ReadBoard(r.body, g_board)) {
        g_error = L"Could not read the board's answer";
        return;
    }
    g_error.clear();
}

// ---------------------------------------------------------------------------
// Drawing

namespace gp = Gdiplus;

static const int kWidth = 280;      // at 100% size and 96 dpi
static const int kMaxHeight = 760;

static HWND g_hwnd;                 // only touched by the HUD thread
static HDC g_memDc;
static HBITMAP g_dib;
static void* g_bits;
static int g_bmpW, g_bmpH, g_drawnH;
static bool g_hidden;

static float g_px = 1.0f;           // pixels per layout unit
static BYTE g_dim = 255;            // 255 normally, lower while the data is stale

static gp::Color Rgb(DWORD rgb, BYTE alpha = 255) {
    return gp::Color((BYTE)(alpha * g_dim / 255), (BYTE)(rgb >> 16), (BYTE)(rgb >> 8), (BYTE)rgb);
}

static const DWORD kBg = 0x0c0c0f, kLine = 0x26262e, kTrack = 0x1c1c23, kText = 0xededf0, kMuted = 0x8d8d9a,
                   kPurple = 0x8457e6, kOk = 0x3fb950, kWarn = 0xd9a520, kDown = 0xe5484d, kPending = 0x4c8dff,
                   kIdle = 0x5c5c68;

static DWORD StateColour(State s) {
    switch (s) {
        case State::Ok: return kOk;
        case State::Warn: return kWarn;
        case State::Down: return kDown;
        case State::Pending: return kPending;
        default: return kIdle;
    }
}

static gp::Font* MakeFont(std::initializer_list<const wchar_t*> names, float size, int style) {
    for (const wchar_t* name : names) {
        gp::FontFamily family(name);
        if (family.GetLastStatus() == gp::Ok && family.IsStyleAvailable(style)) {
            return new gp::Font(&family, size * g_px, style, gp::UnitPixel);
        }
    }
    return new gp::Font(gp::FontFamily::GenericSansSerif(), size * g_px, style, gp::UnitPixel);
}

struct Painter {
    gp::Graphics& g;
    gp::StringFormat fmt{gp::StringFormat::GenericTypographic()};
    gp::Font* sans;
    gp::Font* sansBold;
    gp::Font* small;
    gp::Font* mono;

    explicit Painter(gp::Graphics& graphics) : g(graphics) {
        fmt.SetFormatFlags(fmt.GetFormatFlags() | gp::StringFormatFlagsNoWrap | gp::StringFormatFlagsMeasureTrailingSpaces);
        fmt.SetTrimming(gp::StringTrimmingEllipsisCharacter);
        sans = MakeFont({L"Segoe UI", L"Tahoma", L"Arial"}, 11.5f, gp::FontStyleRegular);
        sansBold = MakeFont({L"Segoe UI Semibold", L"Segoe UI", L"Tahoma", L"Arial"}, 11.5f, gp::FontStyleBold);
        small = MakeFont({L"Segoe UI", L"Tahoma", L"Arial"}, 10.5f, gp::FontStyleRegular);
        mono = MakeFont({L"Cascadia Mono", L"Consolas", L"Lucida Console", L"Courier New"}, 10.0f, gp::FontStyleRegular);
    }
    ~Painter() {
        delete sans;
        delete sansBold;
        delete small;
        delete mono;
    }

    float U(float units) const { return units * g_px; }

    float Measure(const gp::Font* font, const std::wstring& text) {
        gp::RectF box;
        g.MeasureString(text.c_str(), (INT)text.size(), font, gp::PointF(0, 0), &fmt, &box);
        return box.Width;
    }

    // Draws one line of text inside [x, x + width), cutting it with "..." if it is too long.
    void Text(const gp::Font* font, const std::wstring& text, float x, float y, float width, DWORD colour, bool right = false) {
        gp::SolidBrush brush(Rgb(colour));
        fmt.SetAlignment(right ? gp::StringAlignmentFar : gp::StringAlignmentNear);
        gp::RectF box(x, y, width, font->GetHeight(&g) + 1);
        g.DrawString(text.c_str(), (INT)text.size(), font, box, &fmt, &brush);
        fmt.SetAlignment(gp::StringAlignmentNear);
    }

    void Fill(float x, float y, float w, float h, DWORD colour, BYTE alpha = 255) {
        gp::SolidBrush brush(Rgb(colour, alpha));
        g.FillRectangle(&brush, gp::RectF(x, y, w, h));
    }

    // A state square, snapped to whole pixels so its edges stay sharp.
    void Dot(float x, float y, float size, State s) {
        float px = std::round(x), py = std::round(y), ps = std::round(size);
        if (s == State::Idle) {
            gp::Pen pen(Rgb(kIdle), 1);
            g.DrawRectangle(&pen, px + 0.5f, py + 0.5f, ps - 1, ps - 1);
        } else {
            Fill(px, py, ps, ps, StateColour(s));
        }
    }
};

// Lays the HUD out from the top and returns how tall it came out.
static int Paint(gp::Graphics& g, int width) {
    Painter p(g);
    const Board& b = g_board;
    const bool stale = !g_error.empty();
    const State overall = stale ? State::Down : b.overall;

    const float left = p.U(14), right = (float)width - p.U(10), inner = right - left;
    float y = p.U(9);

    // Header: state, name, and the count.
    g_dim = 255;
    p.Dot(left, y + p.U(3.5f), p.U(8), b.loaded || stale ? overall : State::Pending);
    float x = left + p.U(15);
    p.Text(p.sansBold, L"RSVX", x, y, inner, kText);
    x += p.Measure(p.sansBold, L"RSVX ");
    p.Text(p.sansBold, L"STATUS", x, y, inner, kPurple);

    std::wstring tally;
    DWORD tallyColour = kMuted;
    if (stale) {
        tally = L"NO DATA";
        tallyColour = kDown;
    } else if (!b.loaded || !b.ready) {
        tally = L"checking";
    } else if (b.bad) {
        tally = std::to_wstring(b.bad) + (b.bad == 1 ? L" needs attention" : L" need attention");
        tallyColour = StateColour(overall);
    } else {
        tally = std::to_wstring(b.live) + L"/" + std::to_wstring(b.live) + L" ok";
        tallyColour = kOk;
    }
    p.Text(p.mono, tally, left, y + p.U(1.5f), inner, tallyColour, true);
    y += p.U(21);

    if (stale) {
        p.Text(p.small, g_error, left, y, inner, kText);
        y += p.U(18);
    }

    // Everything below comes from the last good answer: dim it if that is old.
    g_dim = stale ? 110 : 255;

    if (g_settings.showBars && !b.bars.empty()) {
        const int perRow = (int)std::min<size_t>(b.bars.size(), 3);
        const float gap = p.U(12);
        const float colW = (inner - gap * (perRow - 1)) / perRow;
        for (size_t i = 0; i < b.bars.size(); i++) {
            const Bar& bar = b.bars[i];
            const int col = (int)(i % perRow);
            if (i && col == 0) y += p.U(27);
            const float bx = left + col * (colW + gap);
            const DWORD fill = bar.value >= 95 ? kDown : bar.value >= 85 ? kWarn : kPurple;
            std::wstring pct = std::to_wstring((int)std::lround(bar.value)) + L"%";
            float pctW = p.Measure(p.mono, pct);
            p.Text(p.mono, bar.label, bx, y, colW - pctW - p.U(4), kMuted);
            p.Text(p.mono, pct, bx, y, colW, fill == kPurple ? kText : fill, true);
            float ty = std::round(y + p.U(15)), th = std::max(2.0f, std::round(p.U(4)));
            p.Fill(std::round(bx), ty, std::round(colW), th, kTrack);
            p.Fill(std::round(bx), ty, std::round(colW * (float)bar.value / 100.0f), th, fill);
        }
        y += p.U(27);
    }

    if (g_settings.showServices && !b.services.empty()) {
        float sx = left;
        for (const Row& s : b.services) {
            float w = p.U(11) + p.Measure(p.mono, s.name);
            if (sx > left && sx + w > right) {
                sx = left;
                y += p.U(16);
            }
            p.Dot(sx, y + p.U(4), p.U(6), s.state);
            p.Text(p.mono, s.name, sx + p.U(11), y, right - sx - p.U(11), s.state == State::Down ? kDown : kText);
            sx += w + p.U(12);
        }
        y += p.U(19);
    }

    if (!b.failures.empty()) {
        p.Fill(left, std::round(y), inner, 1, kLine);
        y += p.U(8);
        const int shown = (int)std::min<size_t>(b.failures.size(), (size_t)g_settings.maxFailures);
        for (int i = 0; i < shown; i++) {
            const Row& f = b.failures[i];
            float tagW = f.group.empty() ? 0 : p.Measure(p.mono, f.group) + p.U(8);
            p.Dot(left, y + p.U(3.5f), p.U(8), f.state);
            p.Text(p.sansBold, f.name, left + p.U(15), y, inner - p.U(15) - tagW, kText);
            if (tagW > 0) p.Text(p.mono, f.group, left, y + p.U(1.5f), inner, StateColour(f.state), true);
            p.Text(p.small, f.summary, left + p.U(15), y + p.U(15), inner - p.U(15), kMuted);
            y += p.U(35);
        }
        if ((int)b.failures.size() > shown) {
            p.Text(p.small, L"and " + std::to_wstring(b.failures.size() - shown) + L" more on the board", left + p.U(15), y, inner - p.U(15), kMuted);
            y += p.U(18);
        }
        y -= p.U(4);
    }

    g_dim = 255;
    return std::min((int)std::ceil(y + p.U(6)), g_bmpH);
}

static void FreeSurface() {
    if (g_memDc) DeleteDC(g_memDc);
    if (g_dib) DeleteObject(g_dib);
    g_memDc = nullptr;
    g_dib = nullptr;
    g_bits = nullptr;
    g_bmpW = g_bmpH = 0;
}

static bool EnsureSurface(int w, int h) {
    if (g_bits && g_bmpW == w && g_bmpH == h) return true;
    FreeSurface();
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;  // top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    HDC screen = GetDC(nullptr);
    g_memDc = CreateCompatibleDC(screen);
    g_dib = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &g_bits, nullptr, 0);
    ReleaseDC(nullptr, screen);
    if (!g_memDc || !g_dib || !g_bits) {
        FreeSurface();
        return false;
    }
    SelectObject(g_memDc, g_dib);
    g_bmpW = w;
    g_bmpH = h;
    return true;
}

static void Render() {
    if (!g_hwnd) return;

    HDC screen = GetDC(nullptr);
    const int dpi = GetDeviceCaps(screen, LOGPIXELSX);
    g_px = (dpi > 0 ? dpi : 96) / 96.0f * g_settings.scale / 100.0f;
    const int w = (int)std::lround(kWidth * g_px);
    const int maxH = (int)std::lround(kMaxHeight * g_px);

    if (EnsureSurface(w, maxH)) {
        int h;
        {
            gp::Bitmap surface(w, maxH, w * 4, PixelFormat32bppPARGB, (BYTE*)g_bits);
            gp::Graphics g(&surface);
            g.SetTextRenderingHint(gp::TextRenderingHintAntiAliasGridFit);
            g.SetSmoothingMode(gp::SmoothingModeNone);
            g.SetPixelOffsetMode(gp::PixelOffsetModeNone);

            // First pass only finds the height, second draws over the panel.
            h = Paint(g, w);
            g.Clear(gp::Color(0, 0, 0, 0));
            const bool stale = !g_error.empty();
            const State overall = stale ? State::Down : g_board.loaded ? g_board.overall : State::Pending;
            gp::SolidBrush panel(gp::Color(238, (BYTE)(kBg >> 16), (BYTE)(kBg >> 8), (BYTE)kBg));
            g.FillRectangle(&panel, 0, 0, w, h);
            gp::Pen border(Rgb(kLine), 1);
            g.DrawRectangle(&border, 0, 0, w - 1, h - 1);
            gp::SolidBrush stripe(Rgb(StateColour(overall)));
            g.FillRectangle(&stripe, 0, 0, std::max(2, (int)std::lround(4 * g_px)), h);
            Paint(g, w);
        }
        g_drawnH = h;

        RECT work = {};
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
        const int ox = (int)std::lround(g_settings.offsetX * g_px), oy = (int)std::lround(g_settings.offsetY * g_px);
        const bool onLeft = g_settings.corner == L"topLeft" || g_settings.corner == L"bottomLeft";
        const bool onBottom = g_settings.corner == L"bottomLeft" || g_settings.corner == L"bottomRight";
        POINT at = {onLeft ? work.left + ox : work.right - ox - w, onBottom ? work.bottom - oy - h : work.top + oy};
        SIZE size = {w, h};
        POINT origin = {0, 0};
        BLENDFUNCTION blend = {AC_SRC_OVER, 0, (BYTE)(g_settings.opacity * 255 / 100), AC_SRC_ALPHA};
        UpdateLayeredWindow(g_hwnd, screen, &at, &size, g_memDc, &origin, 0, &blend, ULW_ALPHA);
    }
    ReleaseDC(nullptr, screen);
}

// ---------------------------------------------------------------------------
// The HUD window and its thread

static const wchar_t kClassName[] = L"RSVXStatusHud";
static const UINT kMsgSettings = WM_APP + 1;
static const UINT_PTR kTimer = 1;
static const int kHotkeyId = 1;

static HANDLE g_thread;
static std::atomic<HWND> g_window{nullptr};  // for the other threads to post to
static std::atomic<bool> g_stop{false};
static ULONGLONG g_nextUpdate;
static int g_ticks;

static void ApplyHotkey() {
    UnregisterHotKey(g_hwnd, kHotkeyId);
    if (g_settings.hotkey && !RegisterHotKey(g_hwnd, kHotkeyId, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_F9)) {
        Wh_Log(L"Ctrl+Alt+F9 is taken by another program");
    }
}

static void UpdateAndRender() {
    Update();
    g_nextUpdate = GetTickCount64() + (ULONGLONG)g_settings.refreshSeconds * 1000;
    Render();
}

static LRESULT CALLBACK HudProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_TIMER:
            if (wParam == kTimer) {
                if (GetTickCount64() >= g_nextUpdate) UpdateAndRender();
                // Other always-on-top windows can end up above; climb back.
                if (++g_ticks % 5 == 0 && !g_hidden) {
                    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                }
            }
            return 0;

        case kMsgSettings:
            LoadSettings();
            g_cookie.clear();
            g_noLoginUntil = 0;
            ApplyHotkey();
            UpdateAndRender();
            return 0;

        case WM_HOTKEY:
            if (wParam == (WPARAM)kHotkeyId) {
                g_hidden = !g_hidden;
                ShowWindow(hwnd, g_hidden ? SW_HIDE : SW_SHOWNOACTIVATE);
            }
            return 0;

        case WM_DISPLAYCHANGE:
        case WM_SETTINGCHANGE:
            Render();  // resolution, scaling or taskbar changed: move back to the corner
            return 0;

        case WM_NCHITTEST:
            return HTTRANSPARENT;

        case WM_DESTROY:
            UnregisterHotKey(hwnd, kHotkeyId);
            KillTimer(hwnd, kTimer);
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

// Explorer can run more than one process (for example with "open folder
// windows in a separate process"). Only the one that owns the desktop gets a HUD.
static bool WaitUntilThisIsTheShell() {
    for (int i = 0; i < 240 && !g_stop; i++) {
        HWND shell = GetShellWindow();
        if (shell) {
            DWORD pid = 0;
            GetWindowThreadProcessId(shell, &pid);
            return pid == GetCurrentProcessId();
        }
        Sleep(500);
    }
    return false;
}

static DWORD WINAPI HudThread(LPVOID) {
    if (!WaitUntilThisIsTheShell()) return 0;

    gp::GdiplusStartupInput startup;
    ULONG_PTR gdiplus = 0;
    if (gp::GdiplusStartup(&gdiplus, &startup, nullptr) != gp::Ok) return 0;

    HINSTANCE module = nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)&HudProc, &module);

    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = HudProc;
    wc.hInstance = module;
    wc.lpszClassName = kClassName;
    if (RegisterClassExW(&wc)) {
        g_hwnd = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                                 kClassName, L"RSVX Status HUD", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, module, nullptr);
        if (g_hwnd) {
            g_window = g_hwnd;
            g_hidden = false;
            ApplyHotkey();
            Render();  // show "checking" straight away
            ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
            UpdateAndRender();
            SetTimer(g_hwnd, kTimer, 1000, nullptr);

            MSG msg;
            while (!g_stop && GetMessageW(&msg, nullptr, 0, 0) > 0) {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            g_window = nullptr;
            if (IsWindow(g_hwnd)) DestroyWindow(g_hwnd);
            g_hwnd = nullptr;
        }
        UnregisterClassW(kClassName, module);
    }

    FreeSurface();
    gp::GdiplusShutdown(gdiplus);
    return 0;
}

BOOL Wh_ModInit() {
    LoadSettings();
    g_stop = false;
    g_thread = CreateThread(nullptr, 0, HudThread, nullptr, 0, nullptr);
    return g_thread != nullptr;
}

void Wh_ModSettingsChanged() {
    HWND hwnd = g_window;
    if (hwnd) PostMessageW(hwnd, kMsgSettings, 0, 0);
}

void Wh_ModUninit() {
    g_stop = true;
    HWND hwnd = g_window;
    if (hwnd) PostMessageW(hwnd, WM_CLOSE, 0, 0);
    if (g_thread) {
        // A request in flight can take a few seconds to give up.
        WaitForSingleObject(g_thread, 30000);
        CloseHandle(g_thread);
        g_thread = nullptr;
    }
}
