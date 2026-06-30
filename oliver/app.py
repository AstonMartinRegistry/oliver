#!/usr/bin/env python3
"""Oliver — a personal reading companion.

Sign up with your Curius account, Oliver fetches everything you've highlighted and
learns your taste. Its browser extension then highlights passages you'd love on any
page and a little parrot explains the connection. This server is multi-tenant: each
account has its own taste index and drives its own extension via an API token.

Run:
    python3 app.py            # http://localhost:8787
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

import db
import taste

ROOT = Path(__file__).parent


def _load_dotenv() -> None:
    for env_file in (ROOT.parent / ".env", ROOT / ".env"):
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

PORT = int(os.environ.get("OLIVER_PORT", "8787"))
COOKIE = "oliver_session"

# A stable secret for signing session cookies; persisted so restarts don't log
# everyone out.
_secret_file = db.DATA_DIR / "secret.key"
if _secret_file.exists():
    SECRET = _secret_file.read_bytes()
else:
    SECRET = secrets.token_bytes(32)
    _secret_file.write_bytes(SECRET)

app = FastAPI(title="Oliver")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
templates = Jinja2Templates(directory=ROOT / "templates")


# ── auth helpers ──────────────────────────────────────────────────────────────

def hash_pw(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return dk.hex(), salt


def verify_pw(password: str, pw_hash: str, salt: str) -> bool:
    cand, _ = hash_pw(password, salt)
    return hmac.compare_digest(cand, pw_hash)


def sign(uid: int) -> str:
    raw = str(uid).encode()
    sig = hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
    return f"{uid}.{sig}"


def unsign(value: str | None) -> int | None:
    if not value or "." not in value:
        return None
    uid_s, sig = value.rsplit(".", 1)
    expected = hmac.new(SECRET, uid_s.encode(), hashlib.sha256).hexdigest()
    if not uid_s.isdigit() or not hmac.compare_digest(sig, expected):
        return None
    return int(uid_s)


def current_user(request: Request):
    uid = unsign(request.cookies.get(COOKIE))
    return db.user_by_id(uid) if uid else None


def bearer_user(request: Request):
    auth = request.headers.get("Authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    return db.user_by_token(token) if token else None


# ── web pages ─────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def landing(request: Request):
    if current_user(request):
        return RedirectResponse("/dashboard", status_code=303)
    return templates.TemplateResponse(request, "landing.html", {"error": None})


@app.post("/signup")
def signup(request: Request, email: str = Form(...), password: str = Form(...), curius: str = Form(...)):
    email = email.strip().lower()
    err = None
    if not email or "@" not in email:
        err = "Enter a valid email."
    elif len(password) < 6:
        err = "Password must be at least 6 characters."
    elif db.user_by_email(email):
        err = "An account with that email already exists."
    else:
        uid_resolved = taste.curius.resolve_user_id(curius)
        if not uid_resolved:
            err = "Couldn't find that Curius account. Try your numeric Curius user ID."
    if err:
        return templates.TemplateResponse(
            request, "landing.html", {"error": err}, status_code=400
        )

    pw_hash, salt = hash_pw(password)
    token = secrets.token_urlsafe(24)
    uid = db.create_user(email, pw_hash, salt, token, uid_resolved)
    taste.start_build(uid, uid_resolved)

    resp = RedirectResponse("/dashboard", status_code=303)
    resp.set_cookie(COOKIE, sign(uid), httponly=True, samesite="lax", max_age=60 * 60 * 24 * 365)
    return resp


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if current_user(request):
        return RedirectResponse("/dashboard", status_code=303)
    return templates.TemplateResponse(request, "login.html", {"error": None})


@app.post("/login")
def login(request: Request, email: str = Form(...), password: str = Form(...)):
    row = db.user_by_email(email.strip().lower())
    if not row or not verify_pw(password, row["pw_hash"], row["pw_salt"]):
        return templates.TemplateResponse(
            request, "login.html", {"error": "Wrong email or password."}, status_code=401
        )
    resp = RedirectResponse("/dashboard", status_code=303)
    resp.set_cookie(COOKIE, sign(row["id"]), httponly=True, samesite="lax", max_age=60 * 60 * 24 * 365)
    return resp


@app.get("/logout")
def logout():
    resp = RedirectResponse("/", status_code=303)
    resp.delete_cookie(COOKIE)
    return resp


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    links = db.links_for(user["id"])
    total_highlights = sum(l["n"] for l in links)
    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "user": user,
            "links": links,
            "total_highlights": total_highlights,
            "api_base": str(request.base_url).rstrip("/"),
        },
    )


@app.post("/links/{link_id}/delete")
def delete_link(request: Request, link_id: int):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    db.delete_link(user["id"], link_id)
    taste.invalidate(user["id"])
    return RedirectResponse("/dashboard", status_code=303)


@app.get("/status")
def status(request: Request):
    user = current_user(request)
    if not user:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    links = db.links_for(user["id"])
    return {
        "status": user["status"],
        "message": user["status_msg"],
        "matches": user["match_count"],
        "links": len(links),
        "highlights": sum(l["n"] for l in links),
    }


# ── extension API (token auth) ──────────────────────────────────────────────────

class ScoreReq(BaseModel):
    blocks: list[str]
    url: str | None = None
    title: str | None = None


class ConnItem(BaseModel):
    paragraph: str
    quote: str
    source: str | None = None


class ConnReq(BaseModel):
    items: list[ConnItem]


class MatchReq(BaseModel):
    count: int = 0


@app.post("/api/login")
def api_login(payload: dict):
    row = db.user_by_email((payload.get("email") or "").strip().lower())
    if not row or not verify_pw(payload.get("password") or "", row["pw_hash"], row["pw_salt"]):
        return JSONResponse({"ok": False, "error": "Wrong email or password."}, status_code=401)
    return {"ok": True, "token": row["token"], "email": row["email"]}


@app.get("/api/health")
def api_health(request: Request):
    user = bearer_user(request)
    if not user:
        return JSONResponse({"ok": False, "error": "Connect Oliver in the dashboard."}, status_code=401)
    links = db.links_for(user["id"])
    return {
        "ok": True,
        "email": user["email"],
        "status": user["status"],
        "highlights": sum(l["n"] for l in links),
        "matches": user["match_count"],
    }


@app.post("/api/score")
def api_score(request: Request, req: ScoreReq):
    user = bearer_user(request)
    if not user:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if user["status"] != "ready":
        return {"scores": [], "building": True}
    return {"scores": taste.score(user["id"], req.blocks)}


@app.post("/api/matches")
def api_matches(request: Request, req: MatchReq):
    user = bearer_user(request)
    if not user:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    total = db.add_matches(user["id"], req.count)
    return {"ok": True, "total": total}


@app.post("/api/connections_stream")
def api_connections_stream(request: Request, req: ConnReq):
    user = bearer_user(request)
    if not user:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    items = req.items[: int(os.environ.get("OLIVER_MAX_CONN", "10"))]

    def gen():
        if not taste.CEREBRAS_API_KEY or not items:
            for i in range(len(items)):
                yield json.dumps({"type": "done", "i": i}) + "\n"
            yield json.dumps({"type": "end"}) + "\n"
            return
        try:
            from cerebras.cloud.sdk import Cerebras

            client = Cerebras(api_key=taste.CEREBRAS_API_KEY)
        except Exception as exc:  # noqa: BLE001
            yield json.dumps({"type": "error", "error": str(exc)}) + "\n"
            return

        for i, it in enumerate(items):
            prompt = taste.connect_prompt(it.paragraph, it.quote, it.source or "")
            for attempt in range(taste.CONN_RETRIES):
                if attempt > 0:
                    yield json.dumps({"type": "reset", "i": i}) + "\n"
                got = ""
                try:
                    stream = client.chat.completions.create(
                        model=taste.CEREBRAS_MODEL,
                        messages=[{"role": "user", "content": prompt}],
                        max_completion_tokens=800,
                        temperature=0.4,
                        stream=True,
                    )
                    for chunk in stream:
                        delta = getattr(chunk.choices[0].delta, "content", "") or ""
                        if delta:
                            got += delta
                            yield json.dumps({"type": "delta", "i": i, "delta": delta}) + "\n"
                except Exception as exc:  # noqa: BLE001
                    print(f"cerebras stream error (attempt {attempt + 1}): {exc}")
                if got.strip():
                    break
                time.sleep(0.5 * (attempt + 1))
            yield json.dumps({"type": "done", "i": i}) + "\n"
        yield json.dumps({"type": "end"}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


if __name__ == "__main__":
    import uvicorn

    print(f"→ Oliver on http://localhost:{PORT}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
