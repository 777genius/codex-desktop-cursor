# Codex Desktop + Cursor

Cursor models inside signed **Codex Desktop** (`ChatGPT.app`). Official GPT chats stay official. Cursor chats stream into Desktop’s native **Thought**, **Read**, and **Ran** cards.

These patches overlay **[cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy)** (`npm`). They do **not** patch ChatGPT.app.

| This release | Codex Desktop | cursor-api-proxy |
| --- | --- | --- |
| `26.908.70816-3` | `26.908.70816` (build `9275`) | `1.4.0` |

The Git tag matches Desktop’s `CFBundleShortVersionString`, with `-2` / `-3` for overlay-only fixes on the same Desktop build.

## Quick start

Need: macOS, signed Codex Desktop, a Cursor account, Node 18+.

```bash
# 1. Cursor CLI (the agent this proxy execs)
curl https://cursor.com/install -fsS | bash
cursor-agent login

# 2. Stock OpenAI-compatible proxy
npm i -g cursor-api-proxy@1.4.0

# 3. This overlay
git clone https://github.com/777genius/codex-desktop-cursor.git
cd codex-desktop-cursor
npm test
node scripts/desktop-version.mjs   # should match 26.908.70816
node scripts/apply.mjs
```

Keep **official GPT** working via [Codex Mixin](https://github.com/Edward-lyz/codex-mixin) (`~/.local/bin/codex-mixin`, worker `:8788`). Mixin is not this repo. Point Mixin (or Desktop) at the proxy:

```toml
# ~/.codex/config.toml  — Cursor traffic only
[model_providers.cursor_proxy]
name = "Cursor"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"

# Keep model_provider = "codex-mixin" for official + Cursor catalog coexistence.
# Mixin routes *-cursor slugs to this proxy.
```

Start the proxy (LaunchAgent or a terminal):

```bash
export CURSOR_BRIDGE_MODE=agent
export CURSOR_BRIDGE_FORCE=true
export CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false
export CURSOR_BRIDGE_CONTEXT_PREAMBLE=false
export CURSOR_BRIDGE_TIMEOUT_MS=900000
export CURSOR_BRIDGE_HOST=127.0.0.1
export CURSOR_BRIDGE_PORT=8765
# optional: pin a default workspace
# export CURSOR_BRIDGE_WORKSPACE="$HOME/dev"

cursor-api-proxy
```

In Desktop, pick a `*-cursor` model (Mixin catalog) or the `cursor_proxy` provider. First turn seeds a Cursor chat; later turns `--resume` that chat.

## What you get

- Official ChatGPT models unchanged (`model_provider = "codex-mixin"`).
- Cursor thinking → Desktop **Thought** accordion (`type: reasoning`).
- Read / grep / shell → Desktop **Read** / **Ran** (`function_call` `exec_command`).
- Web search / fetch → Desktop **Searched the web**.
- Thread id → Cursor `chatId` in `~/.cursor-api-proxy/thread-sessions.json` so a proxy restart does not fork a new chat.

## Versioning

Git tags match Codex Desktop (`26.908.70816`). Overlay-only fixes on that same Desktop build append `-2`, `-3`, …

`package.json` → `codexDesktop.compatible` is the source of truth. `node scripts/desktop-version.mjs` compares it to `/Applications/ChatGPT.app`.

## Layout

```
patches/     overlay copied onto cursor-api-proxy/dist/lib/
test/        SSE contract (Thought / exec_command / no tool replay)
scripts/     apply, desktop-version
```

`npm test` does not need Desktop or a Cursor login.

## Not in this repo

- ChatGPT.app / asar edits
- Mixin binary or model catalogs
- Cursor credentials (`cursor-agent login` stays on your machine)

## License

MIT. Overlay files include code from `cursor-api-proxy` (MIT); see `NOTICE`.
