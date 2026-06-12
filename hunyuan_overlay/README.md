# hunyuan_overlay — scripts Python pré-patchés du runtime 3D

Fichiers copiés tels quels sur le backend installé (`<runtime_root>/backends/hunyuan_<backend>/`)
par `installer::apply_overlay()` :
- à l'installation (étape "code"), et
- à chaque démarrage du serveur par le superviseur — une mise à jour de l'app
  rafraîchit donc les scripts sans réinstallation du backend.

L'overlay n'est appliqué QUE si le dossier backend vit sous `runtime_root()`
(installation gérée par l'app). Un `dir` personnalisé (ex. repo de dev
`C:\dev\3dmodel\Hunyuan3D-2`) n'est jamais écrasé.

## Provenance (mv2)

Base : commit épinglé `f8db63096c8282cb27354314d896feba5ba6ff8a` de
Tencent/Hunyuan3D-2 (le même que `Recipe::repo_zip_url`). **Si le pin change,
régénérer ces fichiers** depuis le nouveau zipball + les patchs ci-dessous
(`patch_gradio_t23d` / `patch_mv2_perf` dans installer.rs restent le fallback
idempotent si un fichier overlay manque).

Patchs inclus par rapport à l'upstream :
- `gradio_app.py` : synthèse d'une vue front via HunyuanDiT quand seul un
  caption est fourni (text-to-3D) ; persistance de la référence rembg
  (`assets_gen_last_ref.png`) ; réduction de faces AVANT texture
  (`HY_FACE_NUM`, défaut 8000).
- `hy3dgen/text2image.py` : `enable_model_cpu_offload()` au lieu d'un
  `.to(cuda)` permanent — sinon HunyuanDiT reste résident en VRAM et ralentit
  la diffusion de forme ~3x sur 16 Go.
- `hy3dgen/texgen/pipelines.py` : render/texture 1024 au lieu de 2048
  (`HY_RENDER_SIZE`/`HY_TEXTURE_SIZE`).
- `hy3dgen/texgen/utils/{multiview,dehighlight}_utils.py` : steps de diffusion
  texture pilotables par env (`HY_TEX_STEPS`/`HY_DELIGHT_STEPS`, défauts
  inchangés).
