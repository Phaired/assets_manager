"""Lossless brightness fix for existing GLBs: set every material's baseColorFactor
to [1,1,1,1] (white) directly in the glTF JSON chunk. The texgen/reduce step left
it at the trimesh default [0.4,0.4,0.4,1] which darkens the albedo to 40% in every
viewer/Roblox. Only the JSON chunk is rewritten; the binary mesh/texture is untouched.

Usage: python fix_brightness.py            # fix all workspace/*/*/model.glb
       python fix_brightness.py <a.glb> ... # fix specific files
Backups: <file>.glb.darkbak
"""
import json, struct, sys, glob, shutil, os

def patch(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, ver, total = struct.unpack("<III", data[:12])
    if magic != 0x46546C67:
        print(f"  skip (not GLB): {path}"); return False
    off = 12
    jlen, jtype = struct.unpack("<II", data[off:off+8])
    jstart = off + 8
    jbytes = data[jstart:jstart+jlen]
    gltf = json.loads(jbytes.decode("utf-8"))
    changed = 0
    for m in gltf.get("materials", []):
        pbr = m.setdefault("pbrMetallicRoughness", {})
        bcf = pbr.get("baseColorFactor")
        if bcf is None or any(abs(c-1.0) > 1e-3 for c in bcf[:3]):
            pbr["baseColorFactor"] = [1.0, 1.0, 1.0, bcf[3] if bcf and len(bcf) > 3 else 1.0]
            changed += 1
    if not changed:
        print(f"  already white: {path}"); return False
    shutil.copy2(path, path + ".darkbak")
    new_json = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    pad = (4 - (len(new_json) % 4)) % 4
    new_json += b" " * pad
    rest = data[jstart+jlen:]              # BIN chunk(s), unchanged
    new_total = 12 + 8 + len(new_json) + len(rest)
    out = struct.pack("<III", magic, ver, new_total)
    out += struct.pack("<II", len(new_json), jtype) + new_json + rest
    with open(path, "wb") as f:
        f.write(out)
    print(f"  fixed {changed} material(s): {path}")
    return True

def main():
    args = sys.argv[1:]
    if not args:
        args = glob.glob(os.path.join("workspace", "*", "*", "model.glb"))
    n = 0
    for p in args:
        if patch(p):
            n += 1
    print(f"Done. {n} file(s) brightened.")

if __name__ == "__main__":
    main()
