"""Run a test page in a headless Chromium browser (Edge or Chrome) and return its <pre id="out"> text."""
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

CANDIDATES = [
    os.environ.get('PAPERSTRATA_BROWSER', ''),
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    shutil.which('chromium') or '', shutil.which('chromium-browser') or '', shutil.which('google-chrome') or '',
]


def find_browser():
    for c in CANDIDATES:
        if c and Path(c).exists():
            return c
    return None


def run_page(rel_path, budget_ms=120000, timeout=300):
    """Load a repo page from file:// (or an http:// URL as is) and return the text of #out once its script finishes."""
    exe = find_browser()
    if not exe:
        raise FileNotFoundError('No Edge or Chrome found; set PAPERSTRATA_BROWSER to its path')
    url = rel_path if rel_path.startswith('http') else (ROOT / rel_path).resolve().as_uri()
    with tempfile.TemporaryDirectory() as profile:
        cmd = [exe, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
               '--allow-file-access-from-files', '--user-data-dir=' + profile,
               '--virtual-time-budget=%d' % budget_ms, '--dump-dom', url]
        out = subprocess.run(cmd, capture_output=True, timeout=timeout).stdout.decode('utf-8', 'replace')
    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', out, re.S)
    if not m:
        raise RuntimeError('Test page produced no output:\n' + out[:2000])
    text = m.group(1)
    return text.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&amp;', '&')
