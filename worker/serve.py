"""Frozen-worker entrypoint.

In dev the Rust core launches the worker as
``python -m uvicorn worker.main:app --host .. --port ..``. That form does not
work inside a PyInstaller one-file/one-folder bundle (there is no ``-m`` and no
console script), so the packaged build is frozen from THIS script, which runs
uvicorn programmatically against the very same ``worker.main:app``.

Usage (matches what ``worker.rs`` passes to the frozen exe):

    worker.exe --host 127.0.0.1 --port <port>
"""
from __future__ import annotations

import argparse

import uvicorn

# Absolute import so PyInstaller bundles the package (worker/__init__.py exists).
from worker.main import app


def main() -> None:
    parser = argparse.ArgumentParser(prog="assets_gen-worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    # Pass the app object directly (not the "worker.main:app" import string):
    # the string form triggers a re-import that is unreliable when frozen.
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
