# Security policy

claude-dispatcher runs an AI agent that executes code and merges pull requests
unattended, so security reports are especially welcome.

## Reporting

Please report vulnerabilities **privately** to the maintainers using the
contact listed for the repository, not in a public issue. Include steps to
reproduce, the impact, and affected versions. You'll get an acknowledgement
and a plan for a fix.

## Scope

In scope, for example:

- the Gitea token or Claude credentials leaking (logs, Claude's environment,
  repo files, error messages);
- ways for issue, comment, review or CI-log content to make the dispatcher
  push, merge or act outside the issue it's working on;
- the dispatcher merging code that CI didn't check.

Out of scope: what Claude does _inside_ the container given untrusted issue
text. That's why the container is the sandbox; see the README's Security
section for the deployment requirements.
