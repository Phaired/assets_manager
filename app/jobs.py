"""Worker de jobs en arriere-plan : execute les etapes de pipeline pour un asset.

Un seul thread worker (GPU serie). Chaque job = (projet, asset_id, [etapes]).
L'etat est persiste dans state.json a chaque transition ; l'UI poll cet etat.
"""
from __future__ import annotations

import queue
import tempfile
import threading
import traceback
from pathlib import Path

from . import config, store
from .pipeline import export_obj, hunyuan_client, mesh, multiview
from .pipeline.server_manager import manager


class JobManager:
    def __init__(self) -> None:
        self._q: "queue.Queue[dict]" = queue.Queue()
        self._lock = threading.Lock()
        self.current: dict | None = None
        self._counter = 0
        threading.Thread(target=self._worker, daemon=True).start()

    def enqueue(self, project: str, asset_id: str, stages: list[str]) -> dict:
        with self._lock:
            self._counter += 1
            job = {"id": self._counter, "project": project, "asset_id": asset_id,
                   "stages": stages, "state": "queued"}
        # marque les etapes demandees comme "queued" pour un retour UI immediat
        for stage in stages:
            store.update_stage(project, asset_id, stage, status="queued")
        self._q.put(job)
        return job

    def snapshot(self) -> dict:
        with self._lock:
            return {"current": self.current, "queue_size": self._q.qsize()}

    # --- interne ---------------------------------------------------------

    def _worker(self) -> None:
        while True:
            job = self._q.get()
            with self._lock:
                self.current = {**job, "state": "running"}
            try:
                self._run_job(job)
            except Exception:  # noqa: BLE001 - ne jamais tuer le worker
                traceback.print_exc()
            finally:
                with self._lock:
                    self.current = None
                self._q.task_done()

    def _run_job(self, job: dict) -> None:
        project, asset_id, stages = job["project"], job["asset_id"], job["stages"]
        for stage in stages:
            try:
                self._run_stage(project, asset_id, stage)
            except Exception as error:  # noqa: BLE001
                store.update_stage(project, asset_id, stage, status="error",
                                   error=f"{type(error).__name__}: {error}")
                # une etape ratee bloque les suivantes (elles dependent de sa sortie)
                break

    def _run_stage(self, project: str, asset_id: str, stage: str) -> None:
        cfg = config.load_config()
        asset = store.get_asset(project, asset_id)
        store.update_stage(project, asset_id, stage, status="running")

        if stage == "multiview":
            self._stage_multiview(cfg, project, asset)
        elif stage == "model3d":
            self._stage_model3d(cfg, project, asset)
        elif stage == "export":
            self._stage_export(cfg, project, asset)
        else:
            raise ValueError(f"etape inconnue: {stage}")

    # --- etapes ----------------------------------------------------------

    def _stage_multiview(self, cfg: dict, project: str, asset: dict) -> None:
        asset_id = asset["id"]
        # une image source manuelle remplace la generation OpenAI
        if asset.get("source") == "manual" and store.source_image_path(project, asset_id).is_file():
            store.update_stage(project, asset_id, "multiview", status="done",
                               meta={"source": "manual"})
            return
        api_key = config.openai_key(cfg)
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY absent (Reglages ou .env)")
        state = store.load_state(project)
        meta = multiview.generate_multiview(
            name=asset["name"], description=asset.get("description", ""),
            output_dir=store.multiview_dir(project, asset_id), api_key=api_key,
            model=cfg["openai_model"], quality=cfg["openai_quality"],
            timeout=cfg["openai_timeout"],
            current_spend=float(state.get("estimated_spend_usd", 0.0)),
            budget_usd=cfg["budget_usd"], est_cost=cfg["estimated_cost_per_image"])
        spent = store.add_spend(project, meta["cost"])
        store.update_stage(project, asset_id, "multiview", status="done",
                           meta={**meta, "estimated_spend_usd": spent})

    def _stage_model3d(self, cfg: dict, project: str, asset: dict) -> None:
        asset_id = asset["id"]
        backend = manager.resolve_backend(asset.get("backend", "auto"))
        seed = hunyuan_client.seed_from_id(asset_id)
        gen3d = cfg["gen3d"]
        dest = store.model_path(project, asset_id)
        base_url = manager.ensure(backend)

        if backend == "v21":
            # image unique : source manuelle si presente, sinon la vue front multivue
            image = store.source_image_path(project, asset_id)
            if not image.is_file():
                image = store.multiview_dir(project, asset_id) / "front.png"
            if not image.is_file():
                raise RuntimeError("aucune image d'entree (multivue ou source) pour le backend v21")
            glb_bytes = hunyuan_client.generate_v21(base_url, image, seed=seed, gen3d=gen3d)
            with tempfile.TemporaryDirectory() as tmp:
                raw = Path(tmp) / "raw.glb"
                raw.write_bytes(glb_bytes)
                meta = mesh.finalize_glb(raw, dest, gen3d["target_face_num"])
        else:  # mv2
            view_dir = store.multiview_dir(project, asset_id)
            missing = [v for v in store.VIEW_FILES if not (view_dir / v).is_file()]
            if missing:
                raise RuntimeError(f"vues multivue manquantes pour mv2: {missing}")
            raw = hunyuan_client.generate_mv2(base_url, view_dir, seed=seed, gen3d=gen3d)
            meta = mesh.finalize_glb(Path(raw), dest, gen3d["target_face_num"])

        meta.update({"backend": backend, "seed": seed, "output": str(dest)})
        store.update_stage(project, asset_id, "model3d", status="done", meta=meta)

    def _stage_export(self, cfg: dict, project: str, asset: dict) -> None:
        asset_id = asset["id"]
        glb = store.model_path(project, asset_id)
        if not glb.is_file():
            raise RuntimeError("model.glb absent : lancer l'etape 3D d'abord")
        dest = store.obj_path(project, asset_id)
        faces, textured = export_obj.export_one(glb, dest)
        store.update_stage(project, asset_id, "export", status="done",
                           meta={"faces": faces, "textured": bool(textured),
                                 "output": str(dest)})


# singleton partage par l'app
jobs = JobManager()
