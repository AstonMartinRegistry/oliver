# personalassistant

A personal knowledge system. Tentacles pull information in, an LLM reasons over
it, and an Obsidian vault stores it. This is the first, simplest piece: a daily
sync that pulls saved Curius links into the vault.

## Curius sync

`curius_sync.py` fetches your saved Curius links and writes one markdown note
per link into the vault. It is incremental — it only writes notes for links it
hasn't seen before (dedup by Curius link id), so it is safe to run every day.

### Run it manually

```bash
python3 curius_sync.py
```

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CURIUS_USER_ID` | `4974` (curius.app/kiss) | Curius numeric user id |
| `VAULT_PATH` | `./vault` | Path to your Obsidian vault |
| `CURIUS_SUBFOLDER` | `Curius` | Folder inside the vault for the notes |

Point it at your real vault:

```bash
VAULT_PATH="$HOME/path/to/your/Obsidian Vault" python3 curius_sync.py
```

### Run it every day

Edit `VAULT_PATH` in `run_curius_sync.sh`, then add a cron entry
(`crontab -e`) to run it daily at 7am:

```cron
0 7 * * * /Users/danielk/Desktop/projects/personalassistant/run_curius_sync.sh
```

Output is appended to `curius_sync.log`.

## What's next (not built yet)

- Fetch full article text when Curius lacks it
- LLM extraction (entities + typed relations) into a real knowledge graph
- Retrieval over the graph for the assistant
# oliver
