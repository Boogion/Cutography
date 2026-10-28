"""Small HTTP helpers on urllib (standard library only)."""
import os
import ssl
import urllib.error
import urllib.request

from . import __version__

USER_AGENT = ("PaperStrata/%s (+local desktop app; makes cardstock relief maps; "
              "Python urllib)" % __version__)

_CA_FALLBACKS = ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt",
                 "/usr/local/etc/openssl/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem")
_ctx = None


def ssl_context():
    """Default TLS context. A frozen macOS build may find no CA bundle through OpenSSL's
    compiled-in path, so fall back to the system's cert.pem when the store is empty."""
    global _ctx
    if _ctx is None:
        ctx = ssl.create_default_context()
        try:
            empty = ctx.cert_store_stats().get("x509_ca", 0) == 0
        except Exception:
            empty = False
        if empty:
            for p in _CA_FALLBACKS:
                if os.path.isfile(p):
                    try:
                        ctx.load_verify_locations(p)
                        break
                    except Exception:
                        pass
        _ctx = ctx
    return _ctx


class HttpError(Exception):
    def __init__(self, msg, status=None, retryable=True):
        Exception.__init__(self, msg)
        self.status = status
        self.retryable = retryable


def request(url, data=None, timeout=60, headers=None):
    """GET (or POST when data is given) and return the body bytes. Raises HttpError."""
    h = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        retry = e.code in (408, 425, 429, 500, 502, 503, 504)
        try:
            e.close()
        except Exception:
            pass
        raise HttpError("HTTP %d from %s" % (e.code, _host(url)), e.code, retry)
    except (urllib.error.URLError, OSError) as e:  # includes socket.timeout, ssl errors
        reason = getattr(e, "reason", e)
        raise HttpError("Couldn't reach %s (%s)" % (_host(url), reason), None, True)


def _host(url):
    try:
        return url.split("/")[2]
    except IndexError:
        return url
