# Contributing

Thanks for helping. This project automates merging code, so changes are held
to a "would I trust this unattended?" bar: small, tested, and explained.

## Setup

```sh
corepack enable
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

Node 22.12+ (see `.node-version`). `scripts/dev-gitea.sh up` gives you a local
Gitea and a running dispatcher to try changes against; don't develop against a
production instance.

## Making changes

- One concern per PR, with tests. Behavior that talks to Gitea is tested with
  the in-memory fake (`test/helpers/fake-gitea.ts`); the runner is tested with
  a fake `claude` binary (`test/fixtures/fake-claude.mjs`); git operations are
  tested against real local repositories.
- When something depends on how Gitea or the Claude Code CLI actually behaves,
  check it against the real thing and say so in the PR (versions included).
- New settings go in `src/config/env.ts`, the schema, `docs/config.md` and
  `.env.example`; a test fails if the docs miss one.
- Comments explain _why_. Keep code free of instance-specific values (hosts,
  users, org names); CI scans for secrets.

## Reporting bugs

Open an issue with what you expected, what happened, versions (dispatcher,
Gitea, Claude Code), and relevant log lines. Logs redact tokens, but check
before pasting.

By contributing you agree that your contributions are licensed under the MIT
license, and to follow the [code of conduct](CODE_OF_CONDUCT.md).
