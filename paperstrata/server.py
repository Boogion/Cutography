"""Local HTTP server: serves web/, fetches sites, saves exports. Binds 127.0.0.1 only."""
import json
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__, paths
from . import coords as coordmod
from . import osm, sitefetch, terrain

MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
    ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".wasm": "application/wasm", ".pdf": "application/pdf", ".zip": "application/zip",
    ".gds": "application/octet-stream", ".xml": "application/xml; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}
MAX_JSON_BODY = 64 << 20         # JSON API bodies
MAX_SAVE_BODY = 2 << 30          # 2 GiB: a 2400 dpi TIFF of a sheet is a few hundred MB; streamed to disk
SITE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
_RESERVED = set(["CON", "PRN", "AUX", "NUL"] + ["COM%d" % i for i in range(1, 10)] +
                ["LPT%d" % i for i in range(1, 10)])


class ApiError(Exception):
    def __init__(self, status, msg):
        Exception.__init__(self, msg)
        self.status = status


# ------------------------------------------------------------------ name sanitising
def clean_segment(s, what="name"):
    s = unicodedata.normalize("NFC", s or "")
    s = _BAD_CHARS.sub("_", s).strip().rstrip(". ").strip()
    if s in ("", ".", ".."):
        raise ApiError(400, "The %s is empty or not allowed." % what)
    if s.split(".")[0].upper() in _RESERVED:
        s = "_" + s
    return s[:120]


def clean_relpath(p):
    """Split a client-supplied relative path into safe segments; reject traversal and absolute paths."""
    p = (p or "").strip()
    if not p:
        raise ApiError(400, "Missing path.")
    if p.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", p) or "\x00" in p:
        raise ApiError(400, "The path must be relative, like sheets/sheet-01.svg.")
    segs = [s for s in re.split(r"[/\\]+", p) if s not in ("", ".")]
    if any(s.strip() == ".." for s in segs):
        raise ApiError(400, "The path can't contain '..'.")
    if not segs:
        raise ApiError(400, "Missing path.")
    if len(segs) > 12:
        raise ApiError(400, "The path is nested too deeply.")
    return [clean_segment(s, "path") for s in segs]


def _within(child, parent):
    child, parent = os.path.realpath(child), os.path.realpath(parent)
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:      # different drives on Windows
        return False


# ------------------------------------------------------------------ sites
class SiteCatalog(object):
    """Example sites (repo sites/), user sites (user folder) and any internal sites (source checkout only)."""

    def __init__(self):
        self._cache = {}
        self._lock = threading.Lock()

    def _sources(self):
        out = []
        d = paths.bundled_sites_dir()
        if os.path.isdir(d):
            out += [(os.path.join(d, f), "example") for f in sorted(os.listdir(d)) if f.endswith(".json")]
        d = paths.user_sites_dir(create=False)
        if os.path.isdir(d):
            out += [(os.path.join(d, f), "user") for f in sorted(os.listdir(d)) if f.endswith(".json")]
        out += [(f, "internal") for f in paths.internal_site_files()]
        return out

    def _meta(self, path, source):
        try:
            st = os.stat(path)
        except OSError:
            return None
        key = (path, st.st_mtime, st.st_size)
        with self._lock:
            hit = self._cache.get(path)
            if hit and hit[0] == key:
                return hit[1]
        try:
            with open(path, "r", encoding="utf-8") as f:
                d = json.load(f)
            sid = d.get("id") or os.path.splitext(os.path.basename(path))[0]
            meta = {"id": sid, "name": d.get("name") or sid, "center": d.get("center"),
                    "diameterM": d.get("diameterM"), "source": source,
                    "createdAt": d.get("createdAt", "")}
        except (OSError, ValueError, AttributeError):
            return None
        with self._lock:
            self._cache[path] = (key, meta)
        return meta

    def list(self):
        seen, out = set(), []
        for path, source in self._sources():
            m = self._meta(path, source)
            if m and m["id"] not in seen:
                seen.add(m["id"])
                out.append(dict(m, _path=path))
        return out

    def find(self, sid):
        for m in self.list():
            if m["id"] == sid:
                return m
        return None

    def ids(self):
        return set(m["id"] for m in self.list())


# ------------------------------------------------------------------ jobs
class Jobs(object):
    def __init__(self, catalog, builder=None):
        self.catalog = catalog
        self.builder = builder or sitefetch.build_site
        self.jobs = {}
        self.lock = threading.Lock()
        self.run_lock = threading.Lock()      # one download at a time; be nice to Overpass
        self.reserved = set()

    def start(self, name, lat, lon, diameter_m):
        jid = secrets.token_hex(6)
        with self.lock:
            self._prune()
            self.jobs[jid] = {"state": "running", "progress": 0.0, "message": "Waiting to start",
                              "_t": time.time()}
        t = threading.Thread(target=self._run, args=(jid, name, lat, lon, diameter_m),
                             name="sitefetch-" + jid, daemon=True)
        t.start()
        return jid

    def get(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            return None if j is None else dict((k, v) for k, v in j.items() if not k.startswith("_"))

    def _update(self, jid, **kw):
        with self.lock:
            self.jobs[jid].update(kw)

    def _prune(self):
        cutoff = time.time() - 3600
        for k in [k for k, v in self.jobs.items() if v["state"] != "running" and v["_t"] < cutoff]:
            del self.jobs[k]

    def _run(self, jid, name, lat, lon, diameter_m):
        if not self.run_lock.acquire(False):
            self._update(jid, message="Waiting for another download to finish")
            self.run_lock.acquire()
        sid = None
        try:
            with self.lock:
                sid = sitefetch.unique_id(sitefetch.slugify(name), self.catalog.ids() | self.reserved)
                self.reserved.add(sid)

            def progress(f, msg):
                self._update(jid, progress=round(f, 3), message=msg)
            site = self.builder(name, lat, lon, diameter_m, progress=progress, site_id=sid)
            path = os.path.join(paths.user_sites_dir(), sid + ".json")
            sitefetch.save(site, path)
            self._update(jid, state="done", progress=1.0, message="Done", siteId=sid, _t=time.time())
        except (osm.OverpassError, terrain.PNGError, sitefetch.SiteError, OSError) as e:
            self._update(jid, state="error", message="Failed", error=str(e), _t=time.time())
        except Exception as e:  # keep the server alive, tell the user something useful
            traceback.print_exc()
            self._update(jid, state="error", message="Failed",
                         error="Something went wrong while building the site: %s" % e, _t=time.time())
        finally:
            with self.lock:
                self.reserved.discard(sid)
            self.run_lock.release()


# ------------------------------------------------------------------ HTTP
def open_folder(path):
    if os.environ.get("PAPERSTRATA_NO_OPEN"):
        return
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def _fallback_index(web):
    pages = sorted(f for f in os.listdir(web) if f.endswith(".html")) if os.path.isdir(web) else []
    links = "".join('<li><a href="/%s">%s</a></li>' % (p, p) for p in pages)
    return ("<!doctype html><meta charset=utf-8><title>PaperStrata</title>"
            "<body style='font-family:system-ui;margin:2em'><h1>PaperStrata</h1>"
            "<ul>%s</ul></body>" % links).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "PaperStrata/" + __version__
    sys_version = ""

    # --- plumbing
    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            BaseHTTPRequestHandler.log_message(self, fmt, *args)

    def log_request(self, code="-", size="-"):
        try:
            c = int(code)
        except (TypeError, ValueError):
            c = 0
        if c >= 500 or getattr(self.server, "verbose", False):
            BaseHTTPRequestHandler.log_request(self, code, size)

    def _allowed_hosts(self):
        port = self.server.server_address[1]
        return ("127.0.0.1:%d" % port, "localhost:%d" % port)

    def _host_ok(self):
        host = (self.headers.get("Host") or "").strip().lower()
        return host in self._allowed_hosts()

    def _origin_ok(self):
        """Block cross-site writes (CSRF): browsers always send Origin on cross-origin POSTs."""
        if (self.headers.get("Sec-Fetch-Site") or "").lower() == "cross-site":
            return False
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        return origin.lower() in tuple("http://" + h for h in self._allowed_hosts())

    def _send(self, status, body, ctype, extra=None, head=False):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _json(self, status, obj, head=False):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", {"Cache-Control": "no-store"}, head)

    def _guard(self, write=False):
        if not self._host_ok():
            self._send(403, b"Forbidden: bad Host header", "text/plain; charset=utf-8")
            return False
        if write and not self._origin_ok():
            self._json(403, {"error": "Cross-site request blocked."})
            return False
        return True

    def _read_json(self):
        n = self._length()
        if n > MAX_JSON_BODY:
            raise ApiError(413, "The request is too large.")
        raw = self.rfile.read(n) if n else b""
        self._body_read = True
        try:
            obj = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "The request body isn't valid JSON.")
        if not isinstance(obj, dict):
            raise ApiError(400, "Expected a JSON object.")
        return obj

    def _drain(self, limit=64 << 20):
        """Read an unread request body so the client sees our error, not a reset connection."""
        if getattr(self, "_body_read", False):
            return
        self._body_read = True
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        if 0 < n <= limit:
            try:
                while n > 0:
                    chunk = self.rfile.read(min(n, 1 << 20))
                    if not chunk:
                        break
                    n -= len(chunk)
            except OSError:
                pass

    def _length(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Bad Content-Length.")
        if n < 0:
            raise ApiError(400, "Bad Content-Length.")
        return n

    def _dispatch(self, method):
        write = method in ("POST", "DELETE", "PUT")
        if not self._guard(write):
            return
        url = urlsplit(self.path)
        path = url.path
        try:
            if path.startswith("/api/"):
                query = parse_qs(url.query, keep_blank_values=True)
                q = dict((k, v[0]) for k, v in query.items())
                self._api(method, path[5:], q)
            elif method in ("GET", "HEAD"):
                self._static(path, head=(method == "HEAD"))
            else:
                self._json(405, {"error": "Method not allowed."})
        except ApiError as e:
            self.close_connection = True
            self._drain()
            self._json(e.status, {"ok": False, "error": str(e)}, head=(method == "HEAD"))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            traceback.print_exc()
            self.close_connection = True
            try:
                self._json(500, {"ok": False, "error": "Internal error: %s" % e})
            except Exception:
                pass

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PUT(self):
        self._dispatch("PUT")

    # --- static files
    def _static(self, path, head=False):
        root, is_web, path_in_root = paths.web_dir(), True, path
        # source-checkout-only folders, never in a frozen build: internal add-ons and the browser tests
        for prefix, folder in (("/internal", paths.internal_dir), ("/tests", paths.tests_dir)):
            if path == prefix or path.startswith(prefix + "/"):
                root, is_web = folder(), False
                if root is None:
                    raise ApiError(404, "Not found.")
                path_in_root = path[len(prefix):] or "/"
                break
        root = os.path.realpath(root)
        rel = unquote(path_in_root)
        if "\x00" in rel or "\\" in rel or any(s == ".." for s in rel.split("/")):
            raise ApiError(404, "Not found.")
        rel = rel.lstrip("/")
        if rel == "" or rel.endswith("/"):
            if not is_web:
                raise ApiError(404, "Not found.")
            rel += "index.html"
        full = os.path.realpath(os.path.join(root, *[s for s in rel.split("/") if s]))
        if not _within(full, root) or full == root:
            raise ApiError(404, "Not found.")
        if os.path.isdir(full):
            self.send_response(301)
            self.send_header("Location", path + "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not os.path.isfile(full):
            if is_web and rel == "index.html":
                self._send(200, _fallback_index(root), MIME[".html"], {"Cache-Control": "no-cache"}, head)
                return
            self._send(404, b"Not found", "text/plain; charset=utf-8", head=head)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            body = f.read()
        self._send(200, body, ctype, {"Cache-Control": "no-cache"}, head)

    # --- API
    def _api(self, method, route, q):
        app = self.server.app
        parts = [p for p in route.split("/") if p]
        head = method == "HEAD"
        if method == "HEAD":
            method = "GET"
        if parts == ["health"] and method == "GET":
            return self._json(200, {"ok": True, "version": __version__}, head)
        if parts == ["coords"] and method == "POST":
            body = self._read_json()
            return self._json(200, coordmod.parse_dict(body.get("text")))
        if parts == ["sites"] and method == "GET":
            sites = [dict((k, v) for k, v in m.items() if k != "_path") for m in app.catalog.list()]
            return self._json(200, {"sites": sites}, head)
        if parts == ["sites"] and method == "POST":
            return self._create_site(self._read_json())
        if len(parts) == 2 and parts[0] == "sites":
            sid = parts[1]
            if not SITE_ID.match(sid):
                raise ApiError(404, "No site with that id.")
            m = app.catalog.find(sid)
            if m is None:
                raise ApiError(404, "No site with that id.")
            if method == "GET":
                with open(m["_path"], "rb") as f:
                    body = f.read()
                return self._send(200, body, MIME[".json"], {"Cache-Control": "no-cache"}, head)
            if method == "DELETE":
                if m["source"] != "user":
                    raise ApiError(403, "Only sites you fetched can be deleted.")
                os.remove(m["_path"])
                return self._json(200, {"ok": True})
        if len(parts) == 2 and parts[0] == "jobs" and method == "GET":
            j = app.jobs.get(parts[1])
            if j is None:
                raise ApiError(404, "No job with that id (jobs are forgotten after an hour).")
            return self._json(200, j, head)
        if parts == ["save"] and method == "POST":
            return self._save(q)
        if parts == ["open"] and method == "POST":
            return self._open(q)
        raise ApiError(404, "Unknown API route.")

    def _create_site(self, body):
        name = body.get("name")
        name = name.strip() if isinstance(name, str) else ""
        if not name:
            raise ApiError(400, "Give the site a name.")
        if len(name) > 80:
            raise ApiError(400, "The name is too long (80 characters at most).")
        try:
            lat, lon, _ = coordmod.parse(body.get("coords"))
        except coordmod.CoordError as e:
            raise ApiError(400, str(e))
        try:
            dm = sitefetch.diameter_metres(body.get("diameter"), body.get("unit") or "km")
        except sitefetch.SiteError as e:
            raise ApiError(400, str(e))
        jid = self.server.app.jobs.start(name, lat, lon, dm)
        return self._json(200, {"job": jid})

    def _project_dir(self, q):
        project = clean_segment(q.get("project", ""), "project name")
        root = paths.output_dir()
        d = os.path.join(root, project)
        if not _within(d, root):
            raise ApiError(400, "Bad project name.")
        return d

    def _save(self, q):
        d = self._project_dir(q)
        segs = clean_relpath(q.get("path", ""))
        target = os.path.join(d, *segs)
        if not _within(target, d):
            raise ApiError(400, "Bad path.")
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(411, "Send the file with a Content-Length.")
        n = self._length()
        if n > MAX_SAVE_BODY:
            raise ApiError(413, "That file is too large to save (2 GB at most).")
        if os.path.isdir(target):
            raise ApiError(409, "A folder with that name already exists.")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = "%s.%s.part" % (target, secrets.token_hex(4))
        self._body_read = True
        try:
            with open(tmp, "wb") as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        raise ApiError(400, "The upload was cut short.")
                    f.write(chunk)
                    left -= len(chunk)
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        return self._json(200, {"ok": True, "path": os.path.abspath(target), "bytes": n})

    def _open(self, q):
        d = self._project_dir(q) if q.get("project") else paths.output_dir()
        os.makedirs(d, exist_ok=True)
        try:
            open_folder(d)
        except OSError as e:
            raise ApiError(500, "Couldn't open the folder: %s" % e)
        return self._json(200, {"ok": True, "path": os.path.abspath(d)})


class App(object):
    def __init__(self, builder=None):
        self.catalog = SiteCatalog()
        self.jobs = Jobs(self.catalog, builder)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets two sockets share a port; never use it there.
    allow_reuse_address = sys.platform != "win32"

    def __init__(self, port, app=None, verbose=False):
        self.app = app or App()
        self.verbose = verbose
        ThreadingHTTPServer.__init__(self, ("127.0.0.1", port), Handler)

    def server_bind(self):
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        ThreadingHTTPServer.server_bind(self)

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout)):
            return
        ThreadingHTTPServer.handle_error(self, request, client_address)

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.server_address[1]


def make_server(port=8765, fallback=True, app=None, verbose=False):
    """Bind 127.0.0.1:port; if it's taken and fallback is set, use a free port instead."""
    try:
        return Server(port, app, verbose)
    except OSError:
        if not fallback or port == 0:
            raise
        return Server(0, app, verbose)
