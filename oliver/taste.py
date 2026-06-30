"""Taste engine: embeddings, per-user index, scoring, and the build job.

The embedding model (all-MiniLM-L6-v2, ~80MB) loads once and is shared by every
user. Each user's highlight vectors live in SQLite; we cache the assembled matrix
in memory per user and rebuild it lazily after a Curius sync or a link deletion.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np

import curius
import db


def _load_dotenv() -> None:
    """Load ../.env then ./.env so env vars are set regardless of import order."""
    here = Path(__file__).parent
    for env_file in (here.parent / ".env", here / ".env"):
        if not env_file.exists():
            continue
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip()
            if k and v and k not in os.environ:
                os.environ[k] = v


_load_dotenv()

TOP_K = int(os.environ.get("OLIVER_TOPK", "3"))
MIN_SCORE = float(os.environ.get("OLIVER_MINSCORE", "0.2"))
EMBED_MODEL = os.environ.get("OLIVER_EMBED_MODEL", "all-MiniLM-L6-v2")

_model = None
_model_lock = threading.Lock()

# per-user cache: uid -> {"vectors": (N,D) float32, "items": [ {text,title,url}, ... ]}
_cache: dict[int, dict] = {}
_cache_lock = threading.Lock()


def model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from sentence_transformers import SentenceTransformer

                print(f"[oliver] loading embedding model: {EMBED_MODEL}…")
                _model = SentenceTransformer(EMBED_MODEL)
                print("[oliver] model ready")
    return _model


def embed(texts: list[str]) -> np.ndarray:
    return model().encode(
        texts, batch_size=64, normalize_embeddings=True, convert_to_numpy=True
    ).astype(np.float32)


def invalidate(uid: int) -> None:
    with _cache_lock:
        _cache.pop(uid, None)


def index_for(uid: int) -> dict:
    """Assemble (and cache) a user's vector matrix + aligned item metadata."""
    with _cache_lock:
        if uid in _cache:
            return _cache[uid]
    rows = db.highlights_for(uid)
    meta = db.highlight_meta(uid)
    if not rows:
        idx = {"vectors": np.zeros((0, 384), dtype=np.float32), "items": []}
    else:
        vecs = np.stack([np.frombuffer(r["vector"], dtype=np.float32) for r in rows])
        items = [
            {
                "text": meta[r["id"]]["text"],
                "title": meta[r["id"]]["title"],
                "url": meta[r["id"]]["url"],
            }
            for r in rows
            if r["id"] in meta
        ]
        idx = {"vectors": vecs.astype(np.float32), "items": items}
    with _cache_lock:
        _cache[uid] = idx
    return idx


def score(uid: int, blocks: list[str]) -> list[dict]:
    """Score page blocks against a user's taste index (same math as the prototype)."""
    idx = index_for(uid)
    vectors, items = idx["vectors"], idx["items"]
    if vectors.shape[0] == 0:
        return []

    cleaned = [(i, b.strip()) for i, b in enumerate(blocks) if len(b.strip()) >= 40]
    if not cleaned:
        return []
    idxs = [i for i, _ in cleaned]
    emb = embed([b for _, b in cleaned])

    sims = emb @ vectors.T
    k = min(TOP_K, sims.shape[1])
    part = np.argpartition(-sims, kth=k - 1, axis=1)[:, :k]
    rows = np.arange(sims.shape[0])[:, None]
    topk = sims[rows, part]
    mean_topk = topk.mean(axis=1)
    best_col = part[rows, np.argmax(topk, axis=1)[:, None]].ravel()

    out: list[dict] = []
    for r, orig_i in enumerate(idxs):
        s = float(max(0.0, mean_topk[r]))
        if s < MIN_SCORE:
            continue
        nn = items[int(best_col[r])]
        out.append(
            {
                "index": int(orig_i),
                "score": round(s, 4),
                "match": nn["text"],
                "source": nn["title"],
                "url": nn.get("url", ""),
            }
        )
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


# ── background build job ────────────────────────────────────────────────────────

def build_user(uid: int, curius_id: str) -> None:
    """Fetch a user's Curius library, embed every highlight, store it. Runs in a thread."""
    try:
        db.set_status(uid, "building", "fetching your Curius library…")
        links = curius.fetch_links(curius_id)
        rows = curius.extract_highlights(links)
        if not rows:
            db.set_status(uid, "error", "No highlights found for that Curius account.")
            return
        db.set_status(uid, "building", f"embedding {len(rows)} highlights…")
        vectors = embed([r["text"] for r in rows])
        db.replace_corpus(uid, rows, vectors)
        invalidate(uid)
        db.set_status(uid, "ready", f"{len(rows)} highlights from {len(links)} links")
    except Exception as exc:  # noqa: BLE001
        db.set_status(uid, "error", f"build failed: {exc}")


def start_build(uid: int, curius_id: str) -> None:
    threading.Thread(target=build_user, args=(uid, curius_id), daemon=True).start()


# ── Cerebras parrot connection ───────────────────────────────────────────────────

CEREBRAS_API_KEY = os.environ.get("CEREBRAS_API_KEY", "")
CEREBRAS_MODEL = os.environ.get("CEREBRAS_MODEL", "gpt-oss-120b")
CONN_RETRIES = int(os.environ.get("OLIVER_CONN_RETRIES", "3"))


def connect_prompt(paragraph: str, quote: str, source: str = "") -> str:
    src = source.strip() or "a piece you saved"
    return (
        "A reader is looking at this PARAGRAPH on a web page:\n"
        f'"""{paragraph[:800]}"""\n\n'
        f'The reader once highlighted this QUOTE, from the source titled "{src}":\n'
        f'"""{quote[:400]}"""\n\n'
        "You are a friendly, chatty parrot perched on the page. In ONE playful "
        "sentence, all lowercase, tell the reader how this paragraph connects to "
        "what they saved. You MUST name the source and the specific idea it talked "
        f'about, e.g. "squawk! this is just like when {src} talked about <idea> '
        '— ...". start with a parrot squawk (squawk!/awk!/rawk!). keep it under 28 '
        "words. output only the sentence — no quotation marks, no preamble."
    )
