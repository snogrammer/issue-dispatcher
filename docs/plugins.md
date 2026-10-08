# Claude Code plugins

Plugins add skills, agents, hooks, MCP servers and language servers to Claude
Code. Each one has a cost. Skills and agents put their descriptions into every
session's context. Hooks run a command on every matching event, which can be
every tool call. Plugins written for interactive use can also stall or loop a
headless run. This page covers which plugins the dispatcher's runs get, and
how the ones used for local development compare.

To see what a plugin adds and what it costs per session:

```sh
claude plugin details <plugin>@<marketplace>
```

## Dispatcher runs

The image installs plugins for the `dispatcher` user at build time (user
scope), so every `claude -p` run loads them. The defaults keep to plugins that
add nothing to the context until used and have no hooks:

| Plugin                                   | Adds                                  | Always-on cost |
| ---------------------------------------- | ------------------------------------- | -------------- |
| `typescript-lsp@claude-plugins-official` | TypeScript/JavaScript language server | ~0             |
| `pyright-lsp@claude-plugins-official`    | Python language server                | ~0             |

The language servers give Claude go-to-definition, references and diagnostics
directly, so it spends fewer turns grepping. The image includes the binaries
they run (`typescript-language-server`, `pyright`).

context7 (current library docs over MCP) is not a default. Its server rejects
requests without auth (`401 Authentication required`). The plugin
authenticates with an interactive OAuth login, which a headless container
can't complete. Supporting it would mean configuring the MCP server directly
with a Context7 API key header instead of using the plugin.

Change the list with build args:

```sh
# Different set (ids are plugin@marketplace, space-separated)
CLAUDE_PLUGINS="typescript-lsp@claude-plugins-official gopls-lsp@claude-plugins-official" docker compose build
# None at all
CLAUDE_PLUGINS=none docker compose build
# A plugin from another marketplace: list every marketplace you need
CLAUDE_MARKETPLACES="anthropics/claude-plugins-official example-org/plugins" \
  CLAUDE_PLUGINS="typescript-lsp@claude-plugins-official tool@example-plugins" docker compose build
```

For published images, set the `CLAUDE_PLUGINS` and `CLAUDE_MARKETPLACES` repo
variables (see `.gitea/workflows/publish.yml`). If a plugin or marketplace
doesn't exist, the build fails. Plugins live in the image, not in a volume, so
rebuilding the image upgrades them along with the CLI.

Other LSP plugins also need their server in the image. `gopls-lsp` needs Go
and `gopls`, `rust-analyzer-lsp` needs `rust-analyzer`, and `ruby-lsp` needs
the `ruby-lsp` gem in each Ruby version. Build your own image `FROM` this one
to add them.

A repository can still enable plugins for its own runs in
`.claude/settings.json` (`enabledPlugins`). They only load if the plugin is
installed in the image.

### Keep out of headless runs

| Plugin                    | Why not                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-mem`              | 6 hooks (every prompt and tool call) and a background worker. The dispatcher already carries context with `--resume` and the issue thread |
| `ralph-loop`              | Its Stop hook keeps the session going, which fights the dispatcher's own run/fix loop and its turn and budget limits                      |
| `security-guidance`       | Runs an extra LLM review on Stop, which costs more per run, and pauses edits on pattern matches with no human to answer                   |
| `ai-literacy-superpowers` | ~10k tokens of skills and agents in every session, plus 4 hooks. It suits a human driving its workflow interactively                      |
| `last30days`              | SessionStart hook. Research tool, not coding                                                                                              |

As a rule, a plugin with hooks needs a reason to run headless. A plugin made
of skills or MCP tools only costs its always-on tokens.

## Local development

These are the plugins installed on the maintainer's machine when this was
written (Claude Code 2.1.294), with their always-on cost per session:

| Plugin                                        | Always-on           | Hooks                                | Verdict                                                      |
| --------------------------------------------- | ------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `ai-literacy-superpowers`                     | ~10.1k tok          | SessionStart, Pre/PostToolUse, Stop  | Enable per project (`--scope project`), only where it's used |
| `claude-mem`                                  | ~1k tok + injection | 6 (incl. every prompt and tool call) | Choose it **or** built-in auto-memory, not both (see below)  |
| `allium`                                      | ~585 tok            | PostToolUse                          | Enable per project, where there are Allium specs             |
| `last30days`                                  | small               | SessionStart                         | Enable when researching, otherwise off                       |
| `ralph-loop`                                  | small               | Stop                                 | Enable when running a loop, otherwise off                    |
| `superdesign`, `humanizer`, `frontend-design` | small               | none                                 | Keep only those you use regularly; per project otherwise     |
| `code-review`, `claude-md-management`         | small               | none                                 | Keep                                                         |
| `context7`                                    | ~0 (deferred MCP)   | none                                 | Keep                                                         |
| `ruby-lsp`                                    | ~0                  | none                                 | Keep for Ruby projects                                       |

Recommendations:

- **Scope heavy plugins to projects.** ai-literacy-superpowers alone adds about
  10k tokens to every session in every repo. Disable it at user scope
  (`claude plugin disable ai-literacy-superpowers@ai-literacy-superpowers`)
  and enable it with `--scope project` in the repos that use its harness. Do
  the same for allium.
- **Use one memory system.** claude-mem injects a summary of recent work at
  SessionStart, which is often several thousand tokens. Claude Code's built-in
  auto-memory (`MEMORY.md`) covers durable facts. Keep claude-mem if you search
  past sessions with it. Otherwise disable it and rely on auto-memory.
- **Add language servers.** `typescript-lsp` (this repo) and `pyright-lsp`
  (Python projects) cost nothing up front and save search turns. They need
  `typescript-language-server` and `pyright` on your `PATH`
  (`npm install -g typescript-language-server typescript pyright`).
- **Clear the plugin cache now and then.** `~/.claude/plugins/cache` keeps
  every version a plugin has been updated through (16 versions of context7
  here). Deleting old version directories is safe. Installed plugins point at
  their current one in `installed_plugins.json`.

## Worth adding

Other plugins were reviewed for review quality, security, frontend and
performance work. Of these, only `pr-review-toolkit` is worth enabling
globally. None of them beats the LSP plugins for the dispatcher's runs, so the
image defaults stay as they are.

| Area             | Plugin (`@claude-plugins-official`)                 | Hooks                               | Verdict                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review           | `pr-review-toolkit`                                 | none                                | **Add.** On-demand agents for what `code-review` doesn't cover: silent failures, test gaps, type design, stale comments                                                                    |
| Security         | `claude-security`                                   | PostToolUse, PermissionRequest, …   | Enable per project for periodic audits. It runs a deep scan with verified findings and proposed patches                                                                                    |
| Security         | `security-guidance`                                 | 5, incl. an LLM diff review on Stop | Skip. It adds a review cost to every session. The built-in `/security-review` covers ad-hoc reviews                                                                                        |
| Frontend         | `playwright` (MCP)                                  | none                                | Skip locally, because the Chrome extension already drives a browser. Add it to a derived image only if a repo needs headless UI checks. It needs Playwright's browsers, several hundred MB |
| Navigation       | `serena` (MCP)                                      | none                                | Skip. The LSP plugins cover it, and it runs unpinned code from Git at start                                                                                                                |
| Built-in overlap | `code-simplifier`, `feature-dev`, `commit-commands` | none                                | Skip. They duplicate `/simplify`, the Plan/Explore agents and the PR workflow                                                                                                              |

No plugin targets runtime performance. For Claude Code's own speed and cost,
the gains are the ones above: fewer always-on tokens and language servers
instead of grep.

### ECC

[ECC](https://github.com/affaan-m/ECC) bundles 68 agents, 293 skills, 94
commands, hooks on session start and end, tool use and compaction, a
"continuous learning" memory, and optional MCP servers. Don't install it
whole:

- **Context cost.** Its catalog adds far more to every session than
  ai-literacy-superpowers' ~10k tokens.
- **Duplication.** Its hooks and memory duplicate claude-mem, auto-memory and
  ai-literacy-superpowers, and it writes hook entries into
  `~/.claude/settings.json`.
- **Headless problems.** It has every problem listed under
  [Keep out of headless runs](#keep-out-of-headless-runs).
- **Unaudited code.** Installing runs package code from npm, and its README
  notes that a version pin is not an audit.

Its individual skills and agents are useful. Cherry-pick them per project from
a checkout you've pinned and read, without the hook runtime:

```sh
git clone https://github.com/affaan-m/ECC && cd ECC   # check out a reviewed tag
./install.sh --target claude --skills security-review,tdd-workflow
# or copy single agents into a project:
cp agents/security-reviewer.md agents/typescript-reviewer.md <repo>/.claude/agents/
```

Matching this stack: the `security-review` and `tdd-workflow` skills, the
`security-reviewer`, `typescript-reviewer` and `python-reviewer` agents, and
`rails-patterns` for Rails. A skill or agent committed to a repo's `.claude/`
directory also reaches the dispatcher's runs on that repo.
