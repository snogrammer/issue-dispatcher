# Publishing checklist

For moving the project from a private instance to a public host.

1. **Secret scan passes** on the full history: CI runs gitleaks over every
   commit (`.gitleaksignore` lists reviewed false positives).
2. **No instance-specific strings** in tracked files or commit messages
   (hostnames, usernames, org names, emails):
   `git log --all -p | grep -iE '<your host>|<your org>|<your user>'` should
   print nothing.
3. **Commit authorship** carries the names and emails of whoever committed and
   of the Gitea instance that made merge commits. Either publish a fresh
   history (one squashed commit), or rewrite authors with
   [`git filter-repo --mailmap`](https://github.com/newren/git-filter-repo)
   on a copy before pushing it to the public remote.
4. **License**: `LICENSE` is MIT, copyright "IssueDispatcher contributors".
5. **Repository links**: issue references like `#12` in commit messages point
   at the private tracker; they're harmless but won't resolve publicly.
6. **Branding** (manual, in Gitea's settings): set the repository avatar to
   `assets/brand/png/issuedispatcher-icon-512.png`, the bot user's avatar to
   the same icon, and the repository website/social preview to
   `assets/brand/social/og-image.png` where the host supports one. See
   [brand](brand.md).
