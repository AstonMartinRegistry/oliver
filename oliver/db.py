"""SQLite storage for Oliver. One file, no external services.

Tables:
  users       — account, login creds, extension token, Curius id, build status,
                and the running match counter shown on the dashboard.
  links       — one row per saved Curius article (what the user can delete).
  highlights  — one row per highlighted passage, with its embedding vector (blob).
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from pathlib import Path

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "oliver.db"

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _init(_conn)
    return _conn


def _init(c: sqlite3.Connection) -> None:
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            email        TEXT UNIQUE NOT NULL,
            pw_hash      TEXT NOT NULL,
            pw_salt      TEXT NOT NULL,
            token        TEXT UNIQUE NOT NULL,
            curius_id    TEXT,
            status       TEXT NOT NULL DEFAULT 'pending',
            status_msg   TEXT NOT NULL DEFAULT '',
            match_count  INTEGER NOT NULL DEFAULT 0,
            created_at   REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS links (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id        INTEGER NOT NULL,
            curius_link_id INTEGER,
            title          TEXT NOT NULL DEFAULT '',
            url            TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS highlights (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id  INTEGER NOT NULL,
            link_id  INTEGER NOT NULL,
            text     TEXT NOT NULL,
            vector   BLOB
        );
        CREATE INDEX IF NOT EXISTS ix_links_user ON links(user_id);
        CREATE INDEX IF NOT EXISTS ix_hl_user ON highlights(user_id);
        CREATE INDEX IF NOT EXISTS ix_hl_link ON highlights(link_id);
        """
    )
    c.commit()


# ── users ────────────────────────────────────────────────────────────────────

def create_user(email: str, pw_hash: str, pw_salt: str, token: str, curius_id: str) -> int:
    with _lock:
        c = conn()
        cur = c.execute(
            "INSERT INTO users (email, pw_hash, pw_salt, token, curius_id, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (email, pw_hash, pw_salt, token, curius_id, time.time()),
        )
        c.commit()
        return cur.lastrowid


def user_by_email(email: str):
    return conn().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()


def user_by_id(uid: int):
    return conn().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def user_by_token(token: str):
    return conn().execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()


def set_status(uid: int, status: str, msg: str = "") -> None:
    with _lock:
        c = conn()
        c.execute("UPDATE users SET status=?, status_msg=? WHERE id=?", (status, msg, uid))
        c.commit()


def add_matches(uid: int, n: int) -> int:
    with _lock:
        c = conn()
        c.execute("UPDATE users SET match_count = match_count + ? WHERE id=?", (max(0, n), uid))
        c.commit()
    row = user_by_id(uid)
    return int(row["match_count"]) if row else 0


# ── links + highlights ─────────────────────────────────────────────────────────

def replace_corpus(uid: int, rows: list[dict], vectors) -> None:
    """Wipe and repopulate a user's links + highlights. `vectors` aligns with rows."""
    with _lock:
        c = conn()
        c.execute("DELETE FROM highlights WHERE user_id=?", (uid,))
        c.execute("DELETE FROM links WHERE user_id=?", (uid,))
        # group rows into links by (curius_link_id, title, url)
        link_ids: dict[tuple, int] = {}
        for row, vec in zip(rows, vectors):
            key = (row.get("curius_link_id"), row["title"], row["url"])
            lid = link_ids.get(key)
            if lid is None:
                cur = c.execute(
                    "INSERT INTO links (user_id, curius_link_id, title, url) VALUES (?,?,?,?)",
                    (uid, row.get("curius_link_id"), row["title"], row["url"]),
                )
                lid = cur.lastrowid
                link_ids[key] = lid
            c.execute(
                "INSERT INTO highlights (user_id, link_id, text, vector) VALUES (?,?,?,?)",
                (uid, lid, row["text"], vec.astype("float32").tobytes()),
            )
        c.commit()


def links_for(uid: int) -> list[sqlite3.Row]:
    return conn().execute(
        "SELECT l.id, l.title, l.url, COUNT(h.id) AS n "
        "FROM links l LEFT JOIN highlights h ON h.link_id = l.id "
        "WHERE l.user_id=? GROUP BY l.id ORDER BY n DESC, l.title",
        (uid,),
    ).fetchall()


def delete_link(uid: int, link_id: int) -> None:
    with _lock:
        c = conn()
        c.execute("DELETE FROM highlights WHERE user_id=? AND link_id=?", (uid, link_id))
        c.execute("DELETE FROM links WHERE user_id=? AND id=?", (uid, link_id))
        c.commit()


def highlights_for(uid: int) -> list[sqlite3.Row]:
    return conn().execute(
        "SELECT id, text, vector FROM highlights WHERE user_id=?", (uid,)
    ).fetchall()


def highlight_meta(uid: int) -> dict[int, dict]:
    """link/title/url per highlight id, for building the in-memory index."""
    rows = conn().execute(
        "SELECT h.id, h.text, l.title, l.url FROM highlights h "
        "JOIN links l ON l.id = h.link_id WHERE h.user_id=?",
        (uid,),
    ).fetchall()
    return {r["id"]: {"text": r["text"], "title": r["title"], "url": r["url"]} for r in rows}
