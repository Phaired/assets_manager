"use strict";

const $ = (sel) => document.querySelector(sel);
const api = async (method, url, body) => {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.status === 204 ? null : r.json();
};

const STAGES = [
  { key: "multiview", label: "Multivue (OpenAI)", hint: "Génère la planche 4 vues via l'API OpenAI." },
  { key: "model3d", label: "3D (Hunyuan)", hint: "Reconstruction + texture sur GPU — peut prendre 1 à 3 min." },
  { key: "export", label: "Export OBJ", hint: "Convertit le .glb en .obj + .mtl + texture." },
];

// Prompts d'exemple — meme style que tools/brainrot_manifest.py : syntagme nominal
// anglais, concis et concret (type de creature + couleurs/matieres/accessoires),
// SANS mots de style (le gabarit prompt_for ajoute deja low-poly / matte / flat colors).
const PRESETS = [
  { name: "Crusher Bot", text: "a stocky steel-blue mining robot with massive metal jaws and chunky tank treads" },
  { name: "Mushling", text: "a cheerful mushroom creature with a big red cap dotted white, round eyes and short stubby legs" },
  { name: "Frog Wizard", text: "a round green frog wizard with a tall pointy purple hat and a small glowing staff" },
  { name: "Lava Golem", text: "a chunky stone golem with glowing orange cracks and mossy boulder shoulders" },
  { name: "Banana Diver", text: "a banana creature wearing a round brass diving helmet and small flippers" },
  { name: "Cat Ninja", text: "a sleek black cat ninja with a red headband and two tiny toy daggers" },
  { name: "Mushroom Tank", text: "a red-capped mushroom fused with chunky toy tank treads and a stubby turret" },
  { name: "Snow Yeti", text: "a fluffy white yeti with rounded blue horns and big mittened hands" },
];

const state = { project: null, assetId: null, data: null, server: null };

function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function elapsed(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// --- projets -------------------------------------------------------------

async function loadProjects() {
  const { projects } = await api("GET", "/api/projects");
  const sel = $("#project-select");
  sel.innerHTML = "";
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = p;
    sel.appendChild(opt);
  }
  if (projects.length) {
    state.project = state.project && projects.includes(state.project) ? state.project : projects[0];
    sel.value = state.project;
    await refresh();
  } else {
    state.project = null;
    $("#asset-list").innerHTML = '<p class="muted">Aucun projet.</p>';
  }
}

async function refresh() {
  if (!state.project) return;
  state.data = await api("GET", `/api/projects/${state.project}`);
  renderAssets();
  if (state.assetId) maybeRenderDetail();
  updateBanner();
}

// Signature de l'état affiché : on ne reconstruit le détail (et donc on ne recharge
// images / model-viewer) que si quelque chose a réellement changé. Évite le spam de
// requêtes et le rechargement du GLB à chaque tick de polling.
function detailSignature(a, st) {
  return JSON.stringify({
    id: a.id, src: a.source, be: a.backend,
    s: STAGES.map((x) => [st[x.key]?.status, st[x.key]?.updated_at]),
  });
}
function maybeRenderDetail() {
  const a = asset();
  if (!a) return;
  const st = state.data.state.assets[a.id] || {};
  if (detailSignature(a, st) !== state.lastDetailSig) renderDetail();
}

// --- liste d'assets ------------------------------------------------------

function stageStatus(assetId, stage) {
  return state.data?.state?.assets?.[assetId]?.[stage]?.status || "pending";
}

function renderAssets() {
  const list = $("#asset-list");
  list.innerHTML = "";
  const assets = state.data?.project?.assets || [];
  if (!assets.length) { list.innerHTML = '<p class="muted">Aucun asset.</p>'; return; }
  for (const a of assets) {
    const div = document.createElement("div");
    div.className = "asset-item" + (a.id === state.assetId ? " active" : "");
    const dots = STAGES.map((s) => `<span class="dot ${stageStatus(a.id, s.key)}"></span>`).join("");
    div.innerHTML = `<span>${a.name}</span><span class="dots">${dots}</span>`;
    div.onclick = () => { state.assetId = a.id; renderAssets(); renderDetail(); };
    list.appendChild(div);
  }
}

// --- detail asset --------------------------------------------------------

function asset() { return (state.data?.project?.assets || []).find((a) => a.id === state.assetId); }

function renderDetail() {
  const a = asset();
  if (!a) { $("#asset-detail").hidden = true; $("#empty-detail").hidden = false; state.lastDetailSig = null; return; }
  $("#empty-detail").hidden = true;
  const box = $("#asset-detail");
  box.hidden = false;
  const st = state.data.state.assets[a.id] || {};
  state.lastDetailSig = detailSignature(a, st);
  // cache-bust STABLE : ne change que quand l'artefact est régénéré (pas à chaque rendu)
  const mvVer = encodeURIComponent(st.multiview?.updated_at || "0");
  const modelVer = encodeURIComponent(st.model3d?.updated_at || "0");
  const base = `/files/${state.project}/${a.id}`;

  const stageCards = STAGES.map((s) => {
    const cur = st[s.key] || { status: "pending" };
    const busy = cur.status === "running" || cur.status === "queued";
    const statusLabel = cur.status === "running"
      ? `<span class="spinner"></span> en cours${elapsed(cur.updated_at) ? " · " + elapsed(cur.updated_at) : ""}`
      : cur.status === "queued" ? "en file…"
      : cur.status === "done" ? "✓ terminé"
      : cur.status === "error" ? "✗ erreur" : "en attente";
    return `<div class="stage">
      <h4>${s.label}</h4>
      <div class="status ${cur.status}">${statusLabel}</div>
      <div class="hint">${s.hint}</div>
      ${cur.error ? `<div class="err">${escapeHtml(cur.error)}</div>` : ""}
      <button class="sm" data-stage="${s.key}" ${busy ? "disabled" : ""}>${cur.status === "done" ? "Relancer" : "Lancer"}</button>
    </div>`;
  }).join("");

  const mvDone = (st.multiview?.status === "done") && a.source !== "manual";
  const gallery = mvDone ? `<div class="views">
    ${["front", "back", "left", "right"].map((v) =>
      `<figure><img src="${base}/multiview/${v}.png?t=${mvVer}" alt="${v}"/><figcaption>${v}</figcaption></figure>`).join("")}
  </div>` : "";

  const modelReady = st.model3d?.status === "done";
  const modelUrl = `${base}/model.glb?t=${modelVer}`;
  const viewer = modelReady ? `<div class="viewer-wrap">
      <model-viewer src="${modelUrl}" camera-controls auto-rotate
        shadow-intensity="1" exposure="1" reveal="auto"></model-viewer>
      <div class="mv-overlay"><span class="spinner big"></span><span>Chargement du modèle 3D…</span></div>
    </div>
    <div class="row">
      <button class="sm ghost" id="btn-enlarge">Agrandir dans le visualiseur</button>
      <a class="sm ghost btnlink" href="${modelUrl}" download="${a.id}.glb">Télécharger .glb</a>
    </div>` : "";
  const objMeta = st.export?.status === "done"
    ? `<p class="muted">OBJ exporté : <code>${escapeHtml(st.export.meta?.output || "")}</code></p>` : "";

  box.innerHTML = `
    <h2>${a.name} <span class="muted">· ${a.id}</span></h2>
    <p class="muted">${escapeHtml(a.description || "")}</p>
    <div class="row">
      <label class="muted" style="flex:0">Backend</label>
      <span class="pill pill-stopped">${a.backend}</span>
      <label class="ghost-file">
        <input type="file" id="src-file" accept="image/*" hidden />
        <button class="sm ghost" id="btn-upload">Image source manuelle</button>
      </label>
      <button class="sm" id="btn-runall">Tout générer</button>
      <button class="sm ghost" id="btn-reset" title="Débloque les étapes coincées en 'en cours'">Réinitialiser</button>
      <button class="sm ghost" id="btn-delete">Supprimer</button>
    </div>
    <div class="stage-grid">${stageCards}</div>
    ${gallery}
    ${viewer}
    ${objMeta}
  `;

  box.querySelectorAll("button[data-stage]").forEach((b) =>
    b.onclick = () => runStages([b.dataset.stage]));
  $("#btn-runall").onclick = () => runStages(["multiview", "model3d", "export"]);
  $("#btn-reset").onclick = async () => {
    await api("POST", `/api/projects/${state.project}/assets/${state.assetId}/reset`);
    await refresh();
  };
  $("#btn-delete").onclick = deleteAsset;
  $("#btn-upload").onclick = () => $("#src-file").click();
  $("#src-file").onchange = uploadSource;

  // masque l'overlay de chargement quand le model-viewer a fini de charger le GLB
  const mv = box.querySelector("model-viewer");
  if (mv) {
    const wrap = mv.closest(".viewer-wrap");
    mv.addEventListener("load", () => wrap.classList.add("loaded"));
    mv.addEventListener("error", () => {
      wrap.classList.add("loaded");
      wrap.querySelector(".mv-overlay")?.remove();
    });
  }
  const enlarge = box.querySelector("#btn-enlarge");
  if (enlarge) enlarge.onclick = () => openViewerWithUrl(modelUrl);
}

async function runStages(stages) {
  await api("POST", `/api/projects/${state.project}/assets/${state.assetId}/generate`, { stages });
  await refresh();
}

async function deleteAsset() {
  if (!confirm("Supprimer cet asset et ses fichiers ?")) return;
  await api("DELETE", `/api/projects/${state.project}/assets/${state.assetId}`);
  state.assetId = null;
  await refresh();
  renderDetail();
}

async function uploadSource(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  await fetch(`/api/projects/${state.project}/assets/${state.assetId}/source`, { method: "POST", body: fd });
  await refresh();
}

// --- serveur -------------------------------------------------------------

async function pollServer() {
  try {
    const s = await api("GET", "/api/server");
    state.server = s;
    const pill = $("#server-pill");
    pill.className = "pill pill-" + (s.status || "stopped");
    const labels = { stopped: "arrêté", starting: "démarrage…", healthy: "prêt", error: "erreur" };
    pill.textContent = `serveur ${s.backend || "—"} · ${labels[s.status] || s.status}`;
    $("#srv-log").textContent = s.log_tail || "(pas encore de logs)";
    updateBanner();
  } catch (e) { /* ignore */ }
}

// Bannière d'activité globale : démarrage serveur (chargement modèle) > job en cours > erreur.
function updateBanner() {
  const banner = $("#activity-banner");
  const s = state.server;
  const job = state.data?.jobs?.current;
  let html = "", cls = "";
  if (s && s.status === "starting") {
    cls = "starting";
    html = `<span class="spinner"></span> Démarrage du serveur Hunyuan <b>${s.backend || ""}</b> — chargement du modèle sur le GPU (1 à 3 min)…
      <span class="banner-log">${escapeHtml((s.log_tail || "").split("\n").pop())}</span>`;
  } else if (job) {
    cls = "running";
    const stages = state.data?.state?.assets?.[job.asset_id] || {};
    const runningKey = STAGES.find((x) => stages[x.key]?.status === "running")?.key;
    const stageLabel = STAGES.find((x) => x.key === runningKey)?.label
      || STAGES.find((x) => job.stages?.includes(x.key))?.label || (job.stages || []).join(", ");
    html = `<span class="spinner"></span> Génération en cours — <b>${escapeHtml(job.asset_id)}</b> · ${stageLabel}`;
  } else if (s && s.status === "error") {
    cls = "error";
    html = `⚠️ Serveur Hunyuan : ${escapeHtml(s.error || "erreur")} <span class="banner-log">${escapeHtml((s.log_tail || "").split("\n").pop())}</span>`;
  }
  banner.hidden = !html;
  banner.className = "banner banner-" + cls;
  banner.innerHTML = html;
}

// --- evenements ----------------------------------------------------------

$("#project-select").onchange = (e) => { state.project = e.target.value; state.assetId = null; refresh(); };
$("#btn-new-project").onclick = async () => {
  const name = prompt("Nom du projet :");
  if (!name) return;
  const p = await api("POST", "/api/projects", { name });
  state.project = p.name;
  await loadProjects();
};

$("#new-asset").onsubmit = async (e) => {
  e.preventDefault();
  if (!state.project) { alert("Crée d'abord un projet."); return; }
  const body = {
    name: $("#asset-name").value.trim(),
    description: $("#asset-desc").value.trim(),
    backend: $("#asset-backend").value,
  };
  const a = await api("POST", `/api/projects/${state.project}/assets`, body);
  $("#asset-name").value = ""; $("#asset-desc").value = "";
  state.assetId = a.id;
  await refresh();
  renderDetail();
};

// reglages
const GEN_KEYS = ["steps_v21", "steps_mv2", "guidance_scale", "octree_resolution",
  "num_chunks", "face_count_v21", "target_face_num"];

$("#btn-settings").onclick = async () => {
  const c = await api("GET", "/api/config");
  $("#cfg-key").value = "";
  $("#cfg-key").placeholder = c.openai_key_set ? "déjà configurée — laisser vide pour garder" : "sk-…";
  $("#cfg-model").value = c.openai_model;
  $("#cfg-quality").value = c.openai_quality;
  $("#cfg-budget").value = c.budget_usd;
  $("#cfg-cost").value = c.estimated_cost_per_image;
  $("#cfg-timeout").value = c.openai_timeout;
  $("#cfg-backend").value = c.default_backend;
  for (const k of GEN_KEYS) $("#g-" + k).value = c.gen3d[k];
  $("#g-texture").checked = !!c.gen3d.texture;
  $("#settings-modal").hidden = false;
};
$("#cfg-close").onclick = () => $("#settings-modal").hidden = true;
$("#cfg-save").onclick = async () => {
  const gen3d = { texture: $("#g-texture").checked };
  for (const k of GEN_KEYS) {
    const v = parseFloat($("#g-" + k).value);
    if (!Number.isNaN(v)) gen3d[k] = v;
  }
  const body = {
    openai_model: $("#cfg-model").value,
    openai_quality: $("#cfg-quality").value,
    budget_usd: parseFloat($("#cfg-budget").value),
    estimated_cost_per_image: parseFloat($("#cfg-cost").value),
    openai_timeout: parseInt($("#cfg-timeout").value, 10),
    default_backend: $("#cfg-backend").value,
    gen3d,
  };
  if ($("#cfg-key").value.trim()) body.openai_api_key = $("#cfg-key").value.trim();
  try {
    await api("PUT", "/api/config", body);
    $("#settings-modal").hidden = true;
  } catch (e) {
    alert("Échec de l'enregistrement : " + e.message);
  }
};
$("#srv-v21").onclick = () => api("POST", "/api/server/start", { backend: "v21" }).then(pollServer);
$("#srv-mv2").onclick = () => api("POST", "/api/server/start", { backend: "mv2" }).then(pollServer);
$("#srv-stop").onclick = () => api("POST", "/api/server/stop").then(pollServer);

// --- visualiseur 3D autonome ---------------------------------------------

let viewerObjectUrl = null;
function setViewerSrc(src) { $("#viewer-mv").setAttribute("src", src); }
function openViewerWithUrl(url) { setViewerSrc(url); $("#viewer-modal").hidden = false; }
function loadViewerFile(file) {
  if (!file) return;
  if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
  viewerObjectUrl = URL.createObjectURL(file);
  setViewerSrc(viewerObjectUrl);
}
$("#btn-viewer").onclick = () => $("#viewer-modal").hidden = false;
$("#viewer-close").onclick = () => $("#viewer-modal").hidden = true;
$("#viewer-file").onchange = (e) => loadViewerFile(e.target.files[0]);
const dz = $("#drop-zone");
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
dz.ondragleave = () => dz.classList.remove("over");
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("over"); loadViewerFile(e.dataTransfer.files[0]); };

// exemples de prompt
function initExamples() {
  const sel = $("#asset-examples");
  for (const p of PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.text;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    if (!sel.value) return;
    $("#asset-desc").value = sel.value;
    const chosen = PRESETS.find((p) => p.text === sel.value);
    if (chosen && !$("#asset-name").value.trim()) $("#asset-name").value = chosen.name;
    sel.selectedIndex = 0;
  };
}

// --- boucle de poll ------------------------------------------------------

initExamples();
loadProjects();
pollServer();
setInterval(() => { refresh().catch(() => {}); }, 2500);
setInterval(pollServer, 3000);
