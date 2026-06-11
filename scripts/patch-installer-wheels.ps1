# ---------------------------------------------------------------------------
# Met à jour `Recipe::ext_wheels` (url + sha256) dans src-tauri/src/installer.rs
# à partir des wheels fraîchement construites dans -WheelDir, en les pointant
# vers la release GitHub -Tag.
#
# Appelé par .github/workflows/build-wheels.yml pour rendre la mise à jour des
# wheels CUDA Hunyuan 100% automatique (plus de copier/coller d'URL ni de sha256).
#
#     pwsh scripts/patch-installer-wheels.ps1 -Tag hunyuan-mv2-cu124-py310-v2
#
# Chaque wheel est rattachée à son bloc `Wheel { url, sha256 }` par son PRÉFIXE de
# nom de paquet (custom_rasterizer / mesh_processor), donc l'ordre et les numéros
# de version des wheels peuvent changer sans casser le patch.
# ---------------------------------------------------------------------------
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$WheelDir = "dist-wheels",
    [string]$InstallerPath = "src-tauri/src/installer.rs",
    [string]$RepoSlug = "Phaired/assets_manager"
)
$ErrorActionPreference = "Stop"

$wheels = Get-ChildItem $WheelDir -Filter *.whl -ErrorAction Stop
if ($wheels.Count -eq 0) { throw "[patch] aucune wheel dans $WheelDir" }

$text = Get-Content $InstallerPath -Raw

foreach ($w in $wheels) {
    $name = $w.Name
    $prefix = ($name -split '-')[0]                 # custom_rasterizer / mesh_processor
    $sha = (Get-FileHash $w.FullName -Algorithm SHA256).Hash.ToLower()
    $url = "https://github.com/$RepoSlug/releases/download/$Tag/$name"

    # Bloc visé :  url: "...<prefix>...",\n  sha256: "...",
    $pattern = '(?s)(url:\s*")[^"]*' + [regex]::Escape($prefix) + '[^"]*(",\s*\r?\n\s*sha256:\s*")[^"]*(")'
    $replacement = '${1}' + $url + '${2}' + $sha + '${3}'
    $updated = [regex]::Replace($text, $pattern, $replacement)
    if ($updated -eq $text) {
        throw "[patch] aucun bloc Wheel trouvé pour le préfixe '$prefix' dans $InstallerPath"
    }
    $text = $updated
    Write-Host "[patch] $prefix -> $name (sha256 $sha)"
}

# UTF-8 SANS BOM (un .rs avec BOM est laid et pollue le diff).
[System.IO.File]::WriteAllText(
    (Resolve-Path $InstallerPath),
    $text,
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "[patch] $InstallerPath mis à jour pour le tag $Tag"
