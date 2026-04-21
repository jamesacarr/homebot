# homebot — Agent guidance

Guidance for humans and coding agents working on this repo. The bot's runtime
LLM has a **separate** system prompt (`src/llm/prompt.ts`) which defines the
bot's user-facing behaviour; that is unrelated to this file.

See [`plan.md`](./plan.md) for the full design and decision log. This file is
conventions only.

## What this project is

A small Telegram bot that accepts natural-language media requests and forwards
them to a home Overseerr instance. Runs as a container on the home NAS. Used
by a handful of family/friends. Low traffic (~10 messages/week). See `plan.md`
for architecture.

## Load-bearing security boundary — READ THIS

The bot's safety property rests on a single invariant:

> The LLM can only call tools we define. v1 exposes three: `search_media`,
> `get_media_details`, `request_media`. v1.x adds `get_recommendations`.

Media titles, overviews, and cast names returned by Overseerr are **untrusted
input**. The system prompt instructs the LLM not to follow instructions
embedded in tool results, but that's mitigation, not prevention. The real
protection is that there is nothing dangerous for the LLM to be tricked into
doing.

**Do not add new tools without a security review.** A tool that touches the
filesystem, shell, network arbitrarily, or external services beyond Overseerr
can turn a harmless prompt injection into something worse. If a feature feels
like it needs a new tool, first check whether the existing tool surface covers
it.

## Module boundaries

The orchestrator is the core, wrapped in adapters.

- **`src/telegram/`** — grammY-specific. Extracts `{ userId, text, callbackData }`
  and hands to the orchestrator. Renders `Reply[]` back to Telegram API calls.
  The only layer that imports `grammy`.
- **`src/llm/`** — orchestrator, system prompt, tool definitions. Imports pi-ai.
  Must not import grammY or kysely directly — depends on interfaces only.
- **`src/overseerr/`** — HTTP client with built-in timeouts and typed errors.
  Owns TMDB poster URL construction (see `plan.md`).
- **`src/db/`** — kysely + better-sqlite3. Migrations, query helpers.
- **`src/config.ts`, `src/logging.ts`, `src/concurrency.ts`, `src/health.ts`** — 
  infrastructure shared across layers.

Rule of thumb: if you catch yourself importing `grammy` from `src/llm/` or
`kysely` from `src/telegram/`, stop and add an interface instead.

## Conventions

### TypeScript

- `"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
  All enabled. Don't weaken them.
- Prefer `interface` for public shapes, `type` for unions/intersections.
- No `any`. If you need to escape types briefly, use `unknown` + a validator,
  not `any`.
- Never use `!` non-null assertions. If the compiler thinks something can be
  null, it probably can — narrow or throw.
- Import type-only with `import type`.

### Error handling

- Never `throw` strings. Use typed error classes exported from the module that
  owns the failure domain (e.g. `OverseerrTimeoutError` in `overseerr/client.ts`).
- Catch at the orchestrator boundary, map to structured log + user-facing reply.
- Don't swallow errors silently. If a path can genuinely ignore an error,
  document why in a comment and log at `debug`.

### Logging

- Always through `src/logging.ts` (pino under the hood). Never `console.log`
  in production code (biome enforces this).
- Prefer `logger.child({ telegramUserId, turnIndex })` to bind context at a
  scope rather than passing the same fields on every call.
- The log message (first arg or `msg` field) should be a stable event name,
  not free prose. Stable names are grep-able; free text isn't.

#### Canonical event names

Use these names for the listed situations so logs across modules stay
coherent. Add new names here as they're introduced — don't invent one-offs
inline.

| Event | Level | Fields |
|---|---|---|
| `startup` | info | `version`, `llmModel`, `llmProvider` |
| `shutdown` | info | `reason` |
| `health_check_failed` | warn | `check` (which criterion failed). error-level with `err` on handler exception |
| `llm_call` | info | `telegramUserId`, `turnIndex`, `model` |
| `llm_call_failed` | error | `telegramUserId`, `err` |
| `llm_tool_round_cap_hit` | warn | `telegramUserId`, `rounds` |
| `tool_call` | info | `telegramUserId`, `toolName`, `args` |
| `tool_error` | warn | `telegramUserId`, `toolName`, `err` |
| `overseerr_timeout` | warn | `path`, `timeoutMs` |
| `request_submitted` | info | `telegramUserId`, `tmdbId`, `title`, `mediaType` |
| `request_duplicate` | info | `telegramUserId`, `tmdbId`, `status` |
| `access_request_received` | info | `telegramUserId`, `telegramUsername` |
| `access_request_ignored_existing` | debug | `telegramUserId`, `status` |
| `access_approved` | info | `telegramUserId`, `decidedBy` |
| `access_denied` | info | `telegramUserId`, `decidedBy` |
| `access_decision_rejected_not_owner` | warn | `telegramUserId`, `decision`, `fromTelegramUserId` |
| `access_dropped_silently` | debug | `telegramUserId`, `status`, optional `callbackKind` |
| `cost_cap_hit` | warn | `telegramUserId`, `dailyCostUsd`, `capUsd` |
| `group_chat_rejected` | info | `chatId`, `chatType` |
| `leave_chat_failed` | warn | `err` |
| `render_failed` | error | `telegramUserId`, `err` |
| `persist_failed` | error | `telegramUserId`, `err` |
| `unhandled_bot_error` | error | `err` |

### Testing

- Framework: `vitest`.
- Every Overseerr client method has tests covering happy path + at least one
  error shape + timeout behaviour.
- Orchestrator tests use `FakeOverseerr` (`test/fakes/`) plus pi-ai's
  built-in `registerFauxProvider()` + `fauxAssistantMessage()` helpers for
  scripting LLM responses. **Do not hand-roll a `FakeLLM`** — pi-ai's faux
  provider is the legitimate external-boundary fake.
- DB tests use in-memory SQLite (`new Database(":memory:")`).
- Test names are behavioural, not mechanical: `"refuses to re-request an already-available title"`, not `"testRequestMedia2"`.
- Prefer minimal mocks. Don't mock what you don't own (e.g. don't mock
  kysely — use a real in-memory DB).

### Database

- DDL changes go through new numbered migration files
  (`src/db/migrations/NNN-description.ts`). **Never edit an existing migration**
  — they've already run in production.
- Prepared-statement handling is kysely's job; don't reach around it with raw
  `db.prepare()` unless there's a specific reason (document it).
- Schema types live in `src/db/types.ts` as a `Database` interface consumed by
  kysely's generic.

### Dependencies

- This project is small. Don't add runtime dependencies casually. Justify in
  the PR description.
- Prefer Node built-ins (`node:http`, `node:fs/promises`, etc.) over
  single-purpose packages.
- Devtools are cheaper but still need justification.

## Tooling

- Package manager: **pnpm**.
- Linter + formatter: **biome** (one tool, faster than eslint+prettier).
- Test runner: **vitest**.
- Dev loop: `pnpm dev` (runs `tsx watch src/index.ts`).
- CI runs: `lint`, `typecheck`, `test`, `build` on every push.

Commands:

```bash
pnpm install         # install dependencies
pnpm dev             # run in watch mode
pnpm test            # run tests once
pnpm test:watch      # tests in watch mode
pnpm typecheck       # tsc --noEmit
pnpm check           # biome check (read-only; this is what CI runs)
pnpm lint            # biome check --write (auto-fix)
pnpm format          # biome format --write
pnpm build           # tsc -p tsconfig.build.json → dist/
pnpm start           # node dist/index.js (after build)
```

## Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/)
enforced by commitlint. Common types:

- `feat:` new functionality
- `fix:` bug fix
- `chore:` tooling, config, non-code changes
- `docs:` documentation only
- `refactor:` code restructuring without behaviour change
- `test:` adding or adjusting tests

Example: `feat(overseerr): add timeout handling to search client`

A Husky `pre-commit` hook runs `lint-staged` which fixes and checks staged
files, then runs `pnpm typecheck`. A `commit-msg` hook runs commitlint against
the message. Both must pass before the commit lands.

## Docker

- Multi-stage build. Builder stage has the native-compile toolchain
  (`build-base`, `python3`) for better-sqlite3; production stage is bare
  `node:24-alpine` with `curl` added for the compose-level healthcheck.
- Runs as non-root user `homebot`.
- No `HEALTHCHECK` instruction in the Dockerfile — the NAS compose file owns
  that, matching the pattern used by every other service in the stack.
- Production image expects `/data` to be a mounted volume containing the
  SQLite file.

## Known quirks

- **lint-staged + husky can pull unstaged changes into a commit.** If your
  working tree has modifications beyond what you staged, the pre-commit hook's
  stash/restore dance sometimes ends with those extra files in the commit
  anyway. Mitigation: stage exactly the files you want in the commit, or
  `--no-verify` when you're certain the hook is misbehaving. Verify the
  commit's file list (`git show --stat HEAD`) after every commit until this
  is root-caused.

## When in doubt

- Read `plan.md` end-to-end. It captures the *why* for most decisions.
- If a plan decision feels wrong once you're implementing, push back with
  reasoning rather than quietly diverging. The plan is editable.
- If you're unsure whether a change crosses a module boundary, it probably
  does.
