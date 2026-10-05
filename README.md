# claude-dispatcher

A small service that lets Claude Code work through a Gitea issue backlog. Assign an
issue to the bot user; the dispatcher runs headless Claude Code against the repo,
opens PRs, follows them through CI to merge, files follow-up issues for a human
reviewer when decisions need confirming, and then picks up the next assigned issue.
It works one issue at a time per repo.

> Status: early scaffold. The full README (architecture, configuration, Gitea
> setup, security notes) arrives with the open-source hygiene work.

## Development

Requires Node 22.12+ (see `.node-version`) and pnpm via corepack.

```sh
corepack enable
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm build && pnpm start
```

Copy `.env.example` to `.env` for local runs. Never commit real values.

## License

MIT (see `LICENSE`).
