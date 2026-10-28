"""Start PaperStrata: python -m paperstrata [--port 8765] [--no-browser]"""
import argparse
import os
import sys
import threading
import webbrowser

if not __package__:  # run as a script (PyInstaller entry point or python paperstrata/__main__.py)
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from paperstrata import __version__, paths, server  # noqa: E402


def _console():
    """Make printing safe: no console (windowed build) or a code page without the em dash."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if stream is None:
            setattr(sys, name, open(os.devnull, "w"))
        else:
            try:
                stream.reconfigure(errors="replace")
            except (AttributeError, ValueError):
                pass


def main(argv=None):
    _console()
    ap = argparse.ArgumentParser(prog="python -m paperstrata", description="PaperStrata")
    ap.add_argument("--port", type=int, default=8765, help="port to listen on (default 8765; "
                    "a free port is used if it's taken)")
    ap.add_argument("--no-browser", action="store_true", help="don't open the browser")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    ap.add_argument("--version", action="version", version=__version__)
    a = ap.parse_args(argv)

    try:
        httpd = server.make_server(a.port, fallback=True, verbose=a.verbose)
    except OSError as e:
        print("Couldn't start the server: %s" % e)
        return 1
    url = httpd.url
    if httpd.server_address[1] != a.port:
        print("Port %d is in use, so using %d instead." % (a.port, httpd.server_address[1]))
    print("PaperStrata is running at %s" % url)
    print("Leave this window open while you work. Close it to quit.")
    print("Your files are saved in %s" % paths.user_home(create=False))
    sys.stdout.flush()
    if not a.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url + "/")).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
