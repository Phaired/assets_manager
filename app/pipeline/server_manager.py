"""Lancement / monitoring / arret des serveurs Hunyuan (v21 FastAPI, mv2 Gradio).

Le GPU etant unique, un seul backend tourne a la fois : demarrer un backend arrete
l'autre. La sonde de sante distingue les deux :
- v21 : GET /health -> 200
- mv2  : GET /gradio_api/info contenant l'endpoint /generation_all
"""
from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

import httpx

from .. import config


def _base_url(backend: str, cfg: dict) -> str:
    h = cfg["hunyuan"][backend]
    return f"http://{h['host']}:{h['port']}"


def probe(backend: str, cfg: dict, timeout: float = 3.0) -> bool:
    base = _base_url(backend, cfg)
    try:
        if backend == "v21":
            r = httpx.get(f"{base}/health", timeout=timeout)
            return r.status_code == 200
        else:  # mv2
            r = httpx.get(f"{base}/gradio_api/info", timeout=timeout)
            return r.status_code == 200 and "/generation_all" in set(
                r.json().get("named_endpoints", {}))
    except Exception:  # noqa: BLE001
        return False


def _command(backend: str, cfg: dict) -> list[str]:
    h = cfg["hunyuan"][backend]
    cmd = [h["python"], h["script"],
           "--host", str(h["host"]), "--port", str(h["port"]),
           "--model_path", h["model_path"], "--subfolder", h["subfolder"]]
    if h.get("texgen_model_path"):
        cmd += ["--texgen_model_path", h["texgen_model_path"]]
    cmd += list(h.get("extra_args", []))
    return cmd


class ServerManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._backend: str | None = None
        self._status: str = "stopped"  # stopped|starting|healthy|error
        self._log_path: Path | None = None
        self._error: str | None = None

    # --- introspection ---------------------------------------------------

    def status(self) -> dict:
        cfg = config.load_config()
        with self._lock:
            backend = self._backend
            status = self._status
            # rapprochement avec la realite : un serveur lance hors de l'app compte aussi
            if status != "healthy":
                for b in ("v21", "mv2"):
                    if probe(b, cfg):
                        backend, status = b, "healthy"
                        break
            return {
                "backend": backend,
                "status": status,
                "base_url": _base_url(backend, cfg) if backend else None,
                "error": self._error,
                "log_tail": self._tail(),
                "managed": self._proc is not None and self._proc.poll() is None,
            }

    def _tail(self, lines: int = 40) -> str:
        if not self._log_path or not self._log_path.is_file():
            return ""
        try:
            text = self._log_path.read_text(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            return ""
        return "\n".join(text.splitlines()[-lines:])

    # --- cycle de vie ----------------------------------------------------

    def start(self, backend: str) -> None:
        cfg = config.load_config()
        with self._lock:
            if self._backend == backend and self._status in ("starting", "healthy") \
                    and self._proc and self._proc.poll() is None:
                return
            if probe(backend, cfg):  # deja lance (ailleurs ou par nous)
                self._backend, self._status, self._error = backend, "healthy", None
                return
            self.stop()  # libere le GPU de l'autre backend
            h = cfg["hunyuan"][backend]
            workdir = Path(h["dir"])
            self._log_path = config.logs_dir() / f"hunyuan_{backend}.log"
            log = open(self._log_path, "ab")
            self._proc = subprocess.Popen(
                _command(backend, cfg), cwd=str(workdir),
                stdout=log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
            self._backend, self._status, self._error = backend, "starting", None
            threading.Thread(target=self._monitor, args=(backend,), daemon=True).start()

    def _monitor(self, backend: str, timeout: float = 900.0) -> None:
        cfg = config.load_config()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                proc = self._proc
            if proc is None or proc.poll() is not None:
                with self._lock:
                    self._status = "error"
                    self._error = f"le serveur {backend} s'est arrete (code {proc.returncode if proc else '?'})"
                return
            if probe(backend, cfg):
                with self._lock:
                    self._status, self._error = "healthy", None
                return
            time.sleep(3.0)
        with self._lock:
            self._status = "error"
            self._error = f"timeout: {backend} non pret apres {int(timeout)}s"

    def stop(self) -> None:
        with self._lock:
            if self._proc and self._proc.poll() is None:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=15)
                except Exception:  # noqa: BLE001
                    self._proc.kill()
            self._proc = None
            self._status = "stopped"
            self._backend = None

    # --- pour les jobs ---------------------------------------------------

    def resolve_backend(self, asset_backend: str) -> str:
        if asset_backend in ("v21", "mv2"):
            return asset_backend
        cfg = config.load_config()
        for b in ("v21", "mv2"):  # privilegie ce qui tourne deja
            if probe(b, cfg):
                return b
        return cfg.get("default_backend", "v21")

    def ensure(self, backend: str, timeout: float = 900.0) -> str:
        """Garantit que `backend` est healthy ; demarre si besoin. Renvoie base_url."""
        cfg = config.load_config()
        if probe(backend, cfg):
            with self._lock:
                self._backend, self._status = backend, "healthy"
            return _base_url(backend, cfg)
        self.start(backend)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                status, error = self._status, self._error
            if status == "healthy":
                return _base_url(backend, cfg)
            if status == "error":
                raise RuntimeError(error or f"echec demarrage {backend}")
            time.sleep(2.0)
        raise RuntimeError(f"timeout demarrage {backend}")


# singleton partage par l'app
manager = ServerManager()
