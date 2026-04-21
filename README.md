# homebot

A small Telegram bot that takes natural-language media requests and forwards
them to a self-hosted [Overseerr](https://overseerr.dev/) instance. Runs as
a container alongside Overseerr in a Docker Compose stack.

> *User:* can you add The Bear to the server?
> *Bot:* Sure! Requested **The Bear (2022)** — full series. ✓

Under the hood: grammY for Telegram, [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai)
for LLM tool-calling (provider-agnostic), and a three-tool surface
(`search_media`, `get_media_details`, `request_media`) — that bounded tool
set is the load-bearing security property, so untrusted Overseerr/TMDB
content can't be coerced into anything dangerous. See [`AGENTS.md`](./AGENTS.md)
for architecture and working conventions.

## Status

Feature-complete for v1. Not yet deployed.

## Prerequisites

- **Telegram bot token** from [@BotFather](https://t.me/BotFather). Keep the
  value; you'll need it for `TELEGRAM_BOT_TOKEN`.
- **Overseerr URL and API key** — API key lives under *Settings → General*
  in the Overseerr admin UI.
- **LLM provider API key** — Anthropic, OpenAI, Groq, etc. pi-ai resolves
  the key by provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).
- **Your numeric Telegram user ID** — any bot like [@userinfobot](https://t.me/userinfobot)
  will tell you. This is `TELEGRAM_OWNER_ID`; owner bypasses the daily
  cost cap and is the only user who can approve access requests.

### One-time Telegram setup

- **Privacy mode on.** In BotFather, `/mybots` → pick your bot → *Bot
  Settings* → *Group Privacy* → *Turn on*. The bot is DM-only; privacy mode
  stops Telegram from delivering group messages in the first place. The bot
  also leaves any group it's added to as a belt-and-braces check.
- **Owner must DM the bot before first startup.** One of the startup sanity
  checks is `getChat(TELEGRAM_OWNER_ID)`, which fails until Telegram
  knows the owner-↔-bot chat exists. Send the bot any message (e.g. `/start`)
  once from your own Telegram account before deploying. The sanity-check
  error hints at this explicitly, but it's easier to get right the first
  time.

## Environment variables

Mirror of [`src/config.ts`](./src/config.ts) and [`.env.example`](./.env.example).

### Required

| Variable | Description |
|---|---|
| `OVERSEERR_URL` | e.g. `http://overseerr:5055` (inside the compose network). |
| `OVERSEERR_API_KEY` | From Overseerr → *Settings → General*. |
| `TELEGRAM_BOT_TOKEN` | From BotFather. |
| `TELEGRAM_OWNER_ID` | Your numeric Telegram user ID. |
| `LLM_PROVIDER` | pi-ai provider key: `anthropic`, `openai`, `groq`, … |
| `LLM_MODEL` | pi-ai model id, e.g. `claude-haiku-4-5`. |
| `<PROVIDER>_API_KEY` | Matches `LLM_PROVIDER`, e.g. `ANTHROPIC_API_KEY`. |

### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `LLM_THINKING_LEVEL` | `off` | `off \| minimal \| low \| medium \| high \| xhigh`. Ignored on non-reasoning models. |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error`. |
| `DB_PATH` | `/data/homebot.db` | SQLite file location; should live on a mounted volume. |
| `DAILY_COST_CAP_USD` | `1.00` | Refuse new LLM calls once this is exceeded (UTC-day bucket). Owner bypasses the cap. |
| `MAX_TURNS_IN_HISTORY` | `15` | Per-user conversation-turn cap; older turns are trimmed on insert. |

### Injected by CI

| Variable | Description |
|---|---|
| `VERSION` | Baked into the image at build time from the commit short SHA. Surfaces in the startup log. Override locally if you're iterating outside Docker. |

## Deployment

The bot ships as a Docker image from GHCR (`ghcr.io/jamesacarr/homebot:latest`)
and is designed to plug into an existing Docker Compose stack on the same
network as Overseerr. There's no separate `docker-compose.yml` in this repo
by design — the service block below is the source of truth; copy it into
your stack's compose file and adjust paths and network names to match your
setup.

```yaml
homebot:
  image: ghcr.io/jamesacarr/homebot:latest
  container_name: homebot
  depends_on:
    - overseerr
  environment:
    ANTHROPIC_API_KEY: ${HOMEBOT_ANTHROPIC_API_KEY}
    LLM_PROVIDER: anthropic
    LLM_MODEL: claude-haiku-4-5
    LLM_THINKING_LEVEL: "off"
    OVERSEERR_URL: http://overseerr:5055
    OVERSEERR_API_KEY: ${HOMEBOT_OVERSEERR_API_KEY}
    TELEGRAM_BOT_TOKEN: ${HOMEBOT_TELEGRAM_BOT_TOKEN}
    TELEGRAM_OWNER_ID: ${HOMEBOT_TELEGRAM_OWNER_ID}
    TZ: ${TIMEZONE}
  healthcheck:
    test: [ "CMD", "curl", "--fail", "http://127.0.0.1:3000/health" ]
    interval: 5s
    retries: 10
  networks:
    - media-net
  restart: always
  volumes:
    - /etc/localtime:/etc/localtime
    - /var/lib/homebot/data:/data
```

Secrets come from the compose stack's `.env` file via `${HOMEBOT_*}`
substitutions. Adjust the substitution names to match your existing
convention; nothing secret should ever be pasted inline or committed.

### Volume layout

- `/var/lib/homebot/data` on the host (adjust to wherever you keep
  persistent service data) ↔ `/data` in the container. Holds `homebot.db`
  (SQLite). The default `DB_PATH` points at `/data/homebot.db`, so you
  don't need to set it unless you're relocating the file inside the
  container.

### Health endpoint

A tiny `node:http` server runs inside the container on `127.0.0.1:3000`,
exposing `GET /health`. Bound to loopback; not reachable from `media-net`
— the in-container `curl` healthcheck above is the only caller. Returns
200 when grammY is polling **and** the DB answers `SELECT 1`; otherwise
503 with a JSON body naming the failed check.

### `:latest` + auto-pull tooling

The example block uses `image: ...:latest` for convenience with auto-pull
tooling like [Watchtower](https://containrrr.dev/watchtower/). If you do
run something similar, be aware: a bad release pulls automatically, there
is no staging gate, and you'll only notice via the healthcheck flapping or
users complaining. For a small self-hosted bot used by a handful of people
that's usually an acceptable trade-off. If it isn't, pin to a `sha-<short>`
tag (CI publishes both) and exclude the container from whatever auto-pull
tool you use.

## Local development

Node.js 24+ (see [`.tool-versions`](./.tool-versions)) and pnpm 10 are
required.

```bash
pnpm install
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN, OVERSEERR_URL, OVERSEERR_API_KEY,
# TELEGRAM_OWNER_ID, LLM_PROVIDER, LLM_MODEL, and the matching
# <PROVIDER>_API_KEY. Point OVERSEERR_URL and DB_PATH at whatever is
# reachable from your dev machine.

pnpm dev          # tsx watch src/index.ts
pnpm test         # vitest run
pnpm test:watch   # vitest
pnpm typecheck    # tsc --noEmit
pnpm check        # biome check (read-only; what CI runs)
pnpm lint         # biome check --write
pnpm build        # tsc -p tsconfig.build.json → dist/
```

Commits use [Conventional Commits](https://www.conventionalcommits.org/),
enforced via commitlint + Husky. `pnpm check`, `pnpm typecheck`, and
`pnpm test` all run in CI on every push.

## License

Private / unlicensed.
