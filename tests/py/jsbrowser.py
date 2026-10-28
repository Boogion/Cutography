"""Run a test page in a headless Chromium browser (Edge or Chrome) and return the results it reports.

Pages finish by POSTing their result text to the URL given in their `report` query parameter. We wait
for that in real time instead of using the browser's --virtual-time-budget, which declares a page done
as soon as it looks idle, even while compression or other work is still running in the background.
Repo-relative pages are served over http from the repo root, so they load like the real app."""
import functools
import http.server
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]

CANDIDATES = [
    os.environ.get('CUTOGRAPHY_BROWSER', ''),
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    shutil.which('google-chrome') or '', shutil.which('chromium') or '', shutil.which('chromium-browser') or '',
]


def find_browser():
    for c in CANDIDATES:
        if c and Path(c).exists():
            return c
    return None


class _Reporter(http.server.SimpleHTTPRequestHandler):
    """Serves the repo read-only and takes one POST to /__result."""
    result = None

    def do_POST(self):
        if self.path.split('?')[0] != '/__result':
            self.send_error(404)
            return
        n = int(self.headers.get('Content-Length') or 0)
        self.server.result = self.rfile.read(n).decode('utf-8', 'replace')
        self.server.done.set()
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

    def log_message(self, *args):
        pass


def run_page(page, timeout=600):
    """Open a repo page (path relative to the repo root) or an http:// URL in a headless browser and
    return the text the page reports when it finishes."""
    exe = find_browser()
    if not exe:
        raise FileNotFoundError('No Edge or Chrome found; set CUTOGRAPHY_BROWSER to its path')
    handler = functools.partial(_Reporter, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    srv.done, srv.result = threading.Event(), None
    threading.Thread(target=srv.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
    base = 'http://127.0.0.1:%d' % srv.server_address[1]
    url = page if page.startswith('http') else base + '/' + page.replace('\\', '/')
    url += ('&' if '?' in url else '?') + 'report=' + quote(base + '/__result', safe='')
    profile = tempfile.mkdtemp(prefix='cutography-browser-')
    try:
        cmd = [exe, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
               '--user-data-dir=' + profile, url]
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            if not srv.done.wait(timeout):
                raise RuntimeError('%s did not report back within %d s' % (page, timeout))
        finally:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
    finally:
        srv.shutdown()
        srv.server_close()
        # the browser's helper processes can still be writing to the profile for a moment
        shutil.rmtree(profile, ignore_errors=True)
    return srv.result
