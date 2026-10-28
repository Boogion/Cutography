"""Where things live: bundled resources (web/, sites/) and the user's data folder.

Resources resolve from the source tree, or from sys._MEIPASS when the app is frozen by
PyInstaller (add the folders with --add-data "web:web" --add-data "sites:sites").

The user data folder is ~/Documents/PaperStrata/ (created on demand). Set the
environment variable PAPERSTRATA_HOME to use a different folder (the tests do).
"""
import os
import sys

APP_NAME = "PaperStrata"


def is_frozen():
    return bool(getattr(sys, "frozen", False)) and hasattr(sys, "_MEIPASS")


def resource_root():
    """Folder that holds web/ and sites/: the repo root from source, _MEIPASS when frozen."""
    if is_frozen():
        return os.path.abspath(sys._MEIPASS)  # type: ignore[attr-defined]
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def web_dir():
    return os.environ.get("PAPERSTRATA_WEB") or os.path.join(resource_root(), "web")


def bundled_sites_dir():
    return os.path.join(resource_root(), "sites")


def internal_dir():
    """The repo's internal/ folder (git-ignored; served at /internal/), or None when frozen or missing."""
    if is_frozen():
        return None
    p = os.path.join(resource_root(), "internal")
    return p if os.path.isdir(p) else None


def tests_dir():
    """The repo's tests/ folder (served at /tests/ so the browser tests run same-origin), or None when frozen."""
    if is_frozen():
        return None
    p = os.path.join(resource_root(), "tests")
    return p if os.path.isdir(p) else None


def internal_site_files():
    """Site files under the repo's internal/ folder (internal/<name>/site.json), from a source checkout only.

    Never resolved when frozen, so internal data can't leak into a packaged build even if someone
    adds the folder by mistake."""
    d = internal_dir()
    if d is None:
        return []
    return sorted(os.path.join(d, n, "site.json") for n in os.listdir(d)
                  if os.path.isfile(os.path.join(d, n, "site.json")))


def _windows_documents():
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                        ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]

        # FOLDERID_Documents {FDD39AD0-238F-46AF-ADB4-6C85480369C7}
        fid = GUID(0xFDD39AD0, 0x238F, 0x46AF,
                   (ctypes.c_ubyte * 8)(0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7))
        buf = ctypes.c_wchar_p()
        shell32 = ctypes.windll.shell32  # type: ignore[attr-defined]
        if shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(buf)) == 0:
            path = buf.value
            ctypes.windll.ole32.CoTaskMemFree(buf)  # type: ignore[attr-defined]
            if path and os.path.isdir(path):
                return path
    except Exception:
        pass
    return None


def _xdg_documents():
    cfg = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "user-dirs.dirs")
    try:
        with open(cfg, encoding="utf-8") as f:
            for line in f:
                if line.startswith("XDG_DOCUMENTS_DIR="):
                    v = line.split("=", 1)[1].strip().strip('"').replace("$HOME", os.path.expanduser("~"))
                    if os.path.isdir(v):
                        return v
    except OSError:
        pass
    return None


def documents_dir():
    d = None
    if sys.platform == "win32":
        d = _windows_documents()  # follows OneDrive / redirected Documents folders
    elif sys.platform.startswith("linux"):
        d = _xdg_documents()
    return d or os.path.join(os.path.expanduser("~"), "Documents")


def user_home(create=True):
    home = os.environ.get("PAPERSTRATA_HOME") or os.path.join(documents_dir(), APP_NAME)
    home = os.path.abspath(home)
    if create:
        os.makedirs(home, exist_ok=True)
    return home


def user_sites_dir(create=True):
    d = os.path.join(user_home(create), "sites")
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def output_dir(create=True):
    d = os.path.join(user_home(create), "output")
    if create:
        os.makedirs(d, exist_ok=True)
    return d
