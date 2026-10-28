"""Server tests: real ThreadingHTTPServer on a free port, temp user folder and web folder."""
import http.client
import json
import os
import shutil
import socket
import tempfile
import threading
import time
import unittest
from urllib.parse import quote

import support  # noqa: F401
from cutography import paths, server


def fake_builder(name, lat, lon, diameter_m, progress=None, site_id=None):
    progress(0.5, "Downloading roads (fake)")
    if name == "Explode":
        raise server.osm.OverpassError("Couldn't download OpenStreetMap data (fake)")
    return {"schema": 1, "id": site_id, "name": name, "center": [lat, lon], "diameterM": diameter_m,
            "createdAt": "2026-01-01T00:00:00Z", "kx": 1, "ky": 1,
            "dem": {"lat0": 0, "lat1": 1, "lon0": 0, "lon1": 1, "cols": 2, "rows": 2, "elev": [0, 0, 0, 0]},
            "buildings": [], "roads": [], "water": [], "mainShapes": [], "attribution": "", "sources": {}}


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="cutography-test-")
        cls.home = os.path.join(cls.tmp, "home")
        cls.web = os.path.join(cls.tmp, "web")
        os.makedirs(os.path.join(cls.web, "js", "sub"))
        files = {"index.html": b"<!doctype html><title>Index</title>",
                 "js/app.js": b"console.log(1)", "js/mod.mjs": b"export default 1",
                 "data.json": b"{}", "f.woff2": b"wOF2", "i.svg": b"<svg/>", "m.wasm": b"\x00asm",
                 "js/sub/index.html": b"sub"}
        for k, v in files.items():
            with open(os.path.join(cls.web, *k.split("/")), "wb") as f:
                f.write(v)
        with open(os.path.join(cls.tmp, "secret.txt"), "wb") as f:
            f.write(b"top secret")
        cls.env = {k: os.environ.get(k) for k in ("CUTOGRAPHY_HOME", "CUTOGRAPHY_WEB", "CUTOGRAPHY_NO_OPEN")}
        os.environ["CUTOGRAPHY_HOME"] = cls.home
        os.environ["CUTOGRAPHY_WEB"] = cls.web
        os.environ["CUTOGRAPHY_NO_OPEN"] = "1"
        cls.httpd = server.make_server(0, fallback=False, app=server.App(builder=fake_builder))
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for k, v in cls.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, method, path, body=None, headers=None, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": host or "127.0.0.1:%d" % self.port}
        h.update(headers or {})
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
            h.setdefault("Content-Type", "application/json")
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in h.items():
            c.putheader(k, v)
        if body is not None:
            c.putheader("Content-Length", str(len(body)))
        c.endheaders(body)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict((k.lower(), v) for k, v in r.getheaders()), data

    def jreq(self, method, path, body=None, **kw):
        status, headers, data = self.req(method, path, body, **kw)
        return status, json.loads(data.decode("utf-8"))

    # --- basics
    def test_health(self):
        status, d = self.jreq("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(d, {"ok": True, "version": "0.1.0"})

    def test_localhost_host_allowed(self):
        status, _, _ = self.req("GET", "/api/health", host="localhost:%d" % self.port)
        self.assertEqual(status, 200)

    def test_static_and_mime(self):
        expect = {"/": "text/html", "/index.html": "text/html", "/js/app.js": "text/javascript",
                  "/js/mod.mjs": "text/javascript", "/data.json": "application/json", "/f.woff2": "font/woff2",
                  "/i.svg": "image/svg+xml", "/m.wasm": "application/wasm", "/js/sub/": "text/html"}
        for path, ctype in expect.items():
            status, h, body = self.req("GET", path)
            self.assertEqual(status, 200, path)
            self.assertTrue(h["content-type"].startswith(ctype), (path, h["content-type"]))
        status, _, body = self.req("GET", "/")
        self.assertIn(b"<title>Index</title>", body)
        status, h, body = self.req("HEAD", "/js/app.js")
        self.assertEqual((status, body, h["content-length"]), (200, b"", "14"))
        status, h, _ = self.req("GET", "/js/sub")
        self.assertEqual(status, 301)
        status, _, _ = self.req("GET", "/missing.js")
        self.assertEqual(status, 404)

    def test_traversal_blocked(self):
        for p in ("/../secret.txt", "/%2e%2e/secret.txt", "/js/%2e%2e/%2e%2e/secret.txt", "/..%5csecret.txt",
                  "/js/..%2f..%2fsecret.txt", "/%00", "//..//secret.txt",
                  "/" + quote(os.path.join(self.tmp, "secret.txt"))):
            status, _, body = self.req("GET", p)
            self.assertIn(status, (400, 403, 404), p)
            self.assertNotIn(b"top secret", body, p)

    def test_bad_host_rejected(self):
        for host in ("evil.example", "evil.example:%d" % self.port, "127.0.0.1:1", "localhost",
                     "127.0.0.1.evil.example:%d" % self.port):
            status, _, _ = self.req("GET", "/api/health", host=host)
            self.assertEqual(status, 403, host)

    def test_cross_origin_write_rejected(self):
        status, d = self.jreq("POST", "/api/coords", {"text": "1, 2"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        status, d = self.jreq("POST", "/api/coords", {"text": "1, 2"},
                              headers={"Origin": "http://127.0.0.1:%d" % self.port})
        self.assertEqual(status, 200)

    # --- coords
    def test_coords(self):
        status, d = self.jreq("POST", "/api/coords", {"text": "35°55'55.2\"N 84°18'34.9\"W"})
        self.assertEqual(status, 200)
        self.assertTrue(d["ok"])
        self.assertEqual(d["format"], "dms")
        self.assertAlmostEqual(d["lat"], 35.932, places=5)
        status, d = self.jreq("POST", "/api/coords", {"text": "nothing here"})
        self.assertEqual(status, 200)
        self.assertFalse(d["ok"])
        self.assertIn("Couldn't find two numbers", d["error"])
        status, d = self.jreq("POST", "/api/coords", b"not json")
        self.assertEqual(status, 400)
        self.assertIn("error", d)

    # --- save / open
    def test_save(self):
        body = b"<svg>sheet</svg>" * 1000
        status, d = self.jreq("POST", "/api/save?project=My%20Map&path=sheets/sheet-01.svg", body)
        self.assertEqual(status, 200, d)
        self.assertTrue(d["ok"])
        expect = os.path.join(self.home, "output", "My Map", "sheets", "sheet-01.svg")
        self.assertEqual(os.path.normcase(d["path"]), os.path.normcase(os.path.abspath(expect)))
        with open(expect, "rb") as f:
            self.assertEqual(f.read(), body)
        # overwrite works
        status, d = self.jreq("POST", "/api/save?project=My%20Map&path=sheets/sheet-01.svg", b"v2")
        self.assertEqual(status, 200)
        with open(expect, "rb") as f:
            self.assertEqual(f.read(), b"v2")
        # backslashes are folder separators too; odd characters are replaced
        status, d = self.jreq("POST", "/api/save?project=P&path=" + quote("a\\b:c?.txt"), b"x")
        self.assertEqual(status, 200, d)
        self.assertTrue(os.path.isfile(os.path.join(self.home, "output", "P", "a", "b_c_.txt")))

    def test_save_rejects_traversal(self):
        bad = [("P", "../escape.txt"), ("P", "a/../../escape.txt"), ("P", "/etc/passwd"), ("P", "C:\\x.txt"),
               ("P", "\\\\server\\share\\x"), ("..", "x.txt"), ("", "x.txt"), ("P", ""), ("P", "..")]
        for project, path in bad:
            status, d = self.jreq("POST", "/api/save?project=%s&path=%s" % (quote(project), quote(path)), b"data")
            self.assertEqual(status, 400, (project, path, d))
            self.assertFalse(d["ok"])
            self.assertTrue(d["error"])
        for root, _, files in os.walk(self.tmp):
            self.assertNotIn("escape.txt", files)

    def test_save_project_with_slash_is_flattened(self):
        status, d = self.jreq("POST", "/api/save?project=a/b&path=x.txt", b"1")
        self.assertEqual(status, 200)
        self.assertTrue(os.path.isfile(os.path.join(self.home, "output", "a_b", "x.txt")))

    def test_open(self):
        status, d = self.jreq("POST", "/api/open?project=Opened")
        self.assertEqual(status, 200)
        self.assertTrue(os.path.isdir(os.path.join(self.home, "output", "Opened")))

    # --- sites and jobs
    def test_sites_list_has_examples(self):
        status, d = self.jreq("GET", "/api/sites")
        self.assertEqual(status, 200)
        ex = [s for s in d["sites"] if s["source"] == "example"]
        if os.path.isfile(os.path.join(paths.bundled_sites_dir(), "rome.json")):
            rome = [s for s in ex if s["id"] == "rome"][0]
            self.assertEqual(rome["diameterM"], 5000)
            self.assertEqual(set(rome), {"id", "name", "center", "diameterM", "source", "createdAt"})
            status, h, body = self.req("GET", "/api/sites/rome")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body.decode("utf-8"))["schema"], 1)
            status, d = self.jreq("DELETE", "/api/sites/rome")
            self.assertEqual(status, 403)
        status, d = self.jreq("GET", "/api/sites/no-such-site")
        self.assertEqual(status, 404)
        status, d = self.jreq("GET", "/api/sites/..%2f..%2fsecret")
        self.assertEqual(status, 404)

    def test_internal_listed_when_present(self):
        status, d = self.jreq("GET", "/api/sites")
        internal = [s for s in d["sites"] if s["source"] == "internal"]
        self.assertEqual(bool(internal), bool(paths.internal_site_files()))

    def test_dev_folders(self):
        # /tests/ (and /internal/ when present) are served from a source checkout, with the same traversal guard
        status, h, body = self.req("GET", "/tests/js/smoke.html")
        self.assertEqual(status, 200)
        self.assertTrue(h["content-type"].startswith("text/html"))
        for p in ("/internal/../cutography/server.py", "/internal/%2e%2e/cutography/server.py", "/internal/",
                  "/tests/../cutography/server.py", "/tests/%2e%2e/cutography/server.py", "/tests/"):
            status, _, _ = self.req("GET", p)
            self.assertEqual(status, 404, p)

    def wait_job(self, jid):
        for _ in range(200):
            status, j = self.jreq("GET", "/api/jobs/" + jid)
            self.assertEqual(status, 200)
            if j["state"] != "running":
                return j
            time.sleep(0.02)
        self.fail("job didn't finish")

    def test_create_fetch_delete_site(self):
        status, d = self.jreq("POST", "/api/sites", {"name": "Test Place", "coords": "35.93201, -84.30970",
                                                     "diameter": 2, "unit": "mi"})
        self.assertEqual(status, 200, d)
        j = self.wait_job(d["job"])
        self.assertEqual(j["state"], "done", j)
        self.assertEqual(j["progress"], 1.0)
        sid = j["siteId"]
        self.assertTrue(sid.startswith("test-place"))
        status, lst = self.jreq("GET", "/api/sites")
        mine = [s for s in lst["sites"] if s["id"] == sid][0]
        self.assertEqual(mine["source"], "user")
        self.assertAlmostEqual(mine["diameterM"], 2 * 1609.344, places=3)
        status, site = self.jreq("GET", "/api/sites/" + sid)
        self.assertEqual(site["name"], "Test Place")
        # second site with the same name gets a new id
        status, d2 = self.jreq("POST", "/api/sites", {"name": "Test Place", "coords": "1, 2", "diameter": 1, "unit": "km"})
        j2 = self.wait_job(d2["job"])
        self.assertNotEqual(j2["siteId"], sid)
        for s in (sid, j2["siteId"]):
            status, d = self.jreq("DELETE", "/api/sites/" + s)
            self.assertEqual((status, d), (200, {"ok": True}))
        status, d = self.jreq("GET", "/api/sites/" + sid)
        self.assertEqual(status, 404)

    def test_job_error(self):
        status, d = self.jreq("POST", "/api/sites", {"name": "Explode", "coords": "1, 2", "diameter": 1})
        j = self.wait_job(d["job"])
        self.assertEqual(j["state"], "error")
        self.assertIn("OpenStreetMap", j["error"])
        status, d = self.jreq("GET", "/api/jobs/nope")
        self.assertEqual(status, 404)

    def test_create_site_validation(self):
        cases = [({"name": "", "coords": "1, 2", "diameter": 5}, "name"),
                 ({"name": "X", "coords": "nope", "diameter": 5}, "Couldn't find two numbers"),
                 ({"name": "X", "coords": "1, 2", "diameter": 50, "unit": "km"}, "between 0.2 and 30 km"),
                 ({"name": "X", "coords": "1, 2", "diameter": 0.1, "unit": "km"}, "between 0.2 and 30 km"),
                 ({"name": "X", "coords": "1, 2", "diameter": 20, "unit": "mi"}, "miles"),
                 ({"name": "X", "coords": "1, 2", "diameter": "big"}, "number"),
                 ({"name": "X", "coords": "100, 2", "diameter": 5}, "Latitude")]
        for body, msg in cases:
            status, d = self.jreq("POST", "/api/sites", body)
            self.assertEqual(status, 400, body)
            self.assertIn(msg, d["error"], body)

    def test_unknown_api(self):
        status, d = self.jreq("GET", "/api/nope")
        self.assertEqual(status, 404)
        self.assertIn("error", d)


class PortFallback(unittest.TestCase):
    def test_busy_port_falls_back(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        busy = s.getsockname()[1]
        try:
            httpd = server.make_server(busy, fallback=True)
            try:
                self.assertNotEqual(httpd.server_address[1], busy)
                self.assertEqual(httpd.server_address[0], "127.0.0.1")
            finally:
                httpd.server_close()
            with self.assertRaises(OSError):
                server.make_server(busy, fallback=False)
        finally:
            s.close()


class Sanitise(unittest.TestCase):
    def test_clean_segment(self):
        self.assertEqual(server.clean_segment("CON"), "_CON")
        self.assertEqual(server.clean_segment("aux.txt"), "_aux.txt")
        self.assertEqual(server.clean_segment("name. "), "name")
        self.assertEqual(server.clean_segment('a<b>c|d*e'), "a_b_c_d_e")
        with self.assertRaises(server.ApiError):
            server.clean_segment("..")


if __name__ == "__main__":
    unittest.main()
