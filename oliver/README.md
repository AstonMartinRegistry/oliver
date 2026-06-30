# Oliver — the reader on your shoulder

Oliver learns your reading taste from your **Curius** highlights, then its browser
extension highlights the passages you'd love on any page and a little parrot
explains the connection to something you saved before.

It's a small multi-tenant product:

- **Sign up** with your email + Curius user ID. A background job fetches your whole
  Curius library and embeds every highlight into your personal taste index.
- **Dashboard** shows how many passages Oliver has spotted for you (one big number),
  your build status, your API token, and every link in your taste — delete any you
  don't want Oliver learning from.
- **Extension** logs into your account (email/password → API token) and scores every
  page against *your* index. Each account drives its own extension.

## Architecture

| Piece | What it does |
|-------|--------------|
| `app.py` | FastAPI: auth (cookie sessions), dashboard, and the token-authed `/api/*` the extension calls. |
| `db.py` | SQLite (`data/oliver.db`): users, links, highlights (+ embedding blobs), match counter. |
| `taste.py` | Shared embedding model, per-user in-memory index, scoring, the Curius build job, Cerebras prompt. |
| `curius.py` | Fetches a user's Curius library (stdlib only). |
| `templates/`, `static/` | Server-rendered landing / login / dashboard. |
| `extension/` | The Chrome extension (token auth, match reporting). |

Scoring is pure vector math (cosine vs. your highlights) — fast and free. Cerebras is
only used to stream the one-sentence parrot note per match.

## Run it

```bash
cd oliver
pip install -r requirements.txt          # first time
python3 app.py                           # → http://localhost:8787
```

Then:

1. Open <http://localhost:8787>, create an account with your Curius user ID
   (the number in `curius.app/api/users/ID/links`).
2. Wait for the dashboard to say **ready** (it fetches + embeds in the background).
3. Load the extension: Chrome → `chrome://extensions` → *Developer mode* →
   *Load unpacked* → select `oliver/extension`.
4. Click the Oliver toolbar icon, log in with your email + password, and browse.

## Config

Reads `../.env` then `oliver/.env` then real env vars:

- `CEREBRAS_API_KEY` — enables the streaming parrot notes (scoring works without it).

That's the only setting you need. A few optional tuning knobs (`OLIVER_PORT`,
`OLIVER_EMBED_MODEL`, `OLIVER_MINSCORE`, `OLIVER_TOPK`, `OLIVER_MAX_CONN`) all have
sensible defaults.

`data/` (SQLite DB + signing key) is per-deployment and should not be committed.
