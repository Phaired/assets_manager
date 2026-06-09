"""assets_gen Python worker sidecar.

Stateless FastAPI app performing the heavy ML compute, called by the Rust core
over localhost HTTP. The ML logic is ported verbatim from the original
``app/pipeline/`` modules (same params, same order).
"""
