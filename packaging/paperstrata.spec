# PyInstaller build for PaperStrata: one double-clickable program per platform.
#   pip install pyinstaller
#   pyinstaller packaging/paperstrata.spec          (output in dist/)
# Bundles web/ and sites/ only. internal/ is never included, and the app ignores it when frozen.
# The program is a console app on purpose: its window says where the app is running and closing
# it quits the app.
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))  # noqa: F821 (SPECPATH is set by PyInstaller)

a = Analysis(  # noqa: F821
    [os.path.join(ROOT, 'paperstrata', '__main__.py')],
    pathex=[ROOT],
    datas=[(os.path.join(ROOT, 'web'), 'web'), (os.path.join(ROOT, 'sites'), 'sites')],
    hiddenimports=['paperstrata.server', 'paperstrata.sitefetch'],
    excludes=['tkinter'],
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821
exe = EXE(  # noqa: F821
    pyz, a.scripts, a.binaries, a.datas, [],
    name='PaperStrata',
    console=True,
    upx=False,
    strip=False,
)
