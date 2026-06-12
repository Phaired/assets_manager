# PyInstaller spec for the assets_gen worker sidecar.
#
# Build from the PROJECT ROOT (so the `worker` package resolves):
#     pyinstaller worker/worker.spec --noconfirm --distpath worker_dist --workpath worker_build
#
# Produces a one-folder bundle at `worker_dist/worker/worker.exe` (+ _internal).
# One-folder (not one-file) is deliberate: pymeshlab ships native libraries and
# data directories that are far more reliable extracted on disk than unpacked
# from a one-file archive at every launch.
#
# The whole `worker_dist/worker/` folder is shipped as a Tauri resource
# (see src-tauri/tauri.conf.json -> bundle.resources) and spawned by worker.rs.

import os

from PyInstaller.utils.hooks import collect_all

# SPECPATH is the directory of this spec (…/worker). The project root is its
# parent, and must be on sys.path so `from worker.main import app` resolves.
ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))

datas = []
binaries = []
hiddenimports = ["worker", "worker.main", "worker.stages"]

# Dynamic-import-heavy / native packages: pull everything so nothing is missed
# at runtime (uvicorn loops & protocols, pymeshlab native libs, trimesh data,
# xatlas/meshoptimizer compiled extensions used by /decimate).
for pkg in ("pymeshlab", "uvicorn", "trimesh", "gradio_client", "xatlas", "meshoptimizer"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

# PIL / numpy / httpx / fastapi / pydantic are picked up by static analysis, but
# a couple of submodules are imported lazily inside stages.py.
hiddenimports += ["PIL.Image", "numpy", "httpx"]

a = Analysis(
    [os.path.join(ROOT, "worker", "serve.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyQt5", "PySide6"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="worker",
    console=True,
    disable_windowed_traceback=False,
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    upx=False,
    name="worker",
)
