# homebot

A small Telegram bot that accepts natural-language media requests and forwards
them to a home [Overseerr](https://overseerr.dev/) instance.

> "can you add The Bear to the server?" → *Requested The Bear (2022). ✓*

## Status

Early development. See [`plan.md`](./plan.md) for the full design and
[`AGENTS.md`](./AGENTS.md) for working conventions.

## Requirements

- Node.js 24+
- pnpm
- Docker (for deployment)
- A Telegram bot token from [BotFather](https://t.me/BotFather)
- A running Overseerr instance with an API key

## Local development

```bash
pnpm install
cp .env.example .env
# Fill in the required values in .env

pnpm dev        # run in watch mode
pnpm test       # run tests
pnpm typecheck  # type check only
pnpm lint       # lint + format check
```

## Deployment

The bot is designed to run as a Docker container alongside Overseerr in a
compose stack. See `plan.md` → *Deployment* for the compose snippet.

## License

Private / unlicensed.
