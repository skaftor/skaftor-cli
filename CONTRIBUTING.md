# Contributing to Skaftor CLI

Thanks for your interest in improving `skaftor`! This CLI is intentionally small and
**zero-dependency** (Node 18+ built-ins only), which keeps it fast to install and easy
to audit. Contributions that preserve that constraint are especially welcome.

## Ways to contribute

- **Report a bug** — open a [Bug report](https://github.com/skaftor/skaftor-cli/issues/new/choose).
- **Request a feature** — open a [Feature request](https://github.com/skaftor/skaftor-cli/issues/new/choose).
- **Ask/discuss** — use [Discussions](https://github.com/skaftor/skaftor-cli/discussions).
- **Send a PR** — for anything non-trivial, please open an issue first so we can agree on the approach.

## Development setup

```bash
git clone https://github.com/skaftor/skaftor-cli.git
cd skaftor-cli
node bin/skaftor.mjs --version      # run it directly (no install/build step)
npm run smoke                       # quick sanity check
npm link                            # expose `skaftor` globally while hacking
```

There is **no build step** and **no runtime dependencies**. `bin/skaftor.mjs` is the
whole program.

## Ground rules

1. **Keep it dependency-free.** Use only Node.js built-ins (`node:fs`, `node:https`,
   `node:os`, `node:path`, …). A PR that adds an npm dependency will be declined unless
   there's an exceptional reason.
2. **Node 18+ only.** Don't use APIs newer than the declared `engines` range.
3. **Fail gracefully.** Network/auth errors should print a clear, actionable message —
   never a raw stack trace to end users.
4. **Respect the token.** Never log the dev token or write it anywhere but
   `~/.skaftor/config.json` (mode `600`).
5. **Match the style.** Small functions, clear names, comments that explain *why*.

## Pull request process

1. Fork and create a branch: `git checkout -b fix/short-description`.
2. Make your change; run `npm run lint` (syntax check) and `npm run smoke`.
3. Add a line to [`CHANGELOG.md`](./CHANGELOG.md) under `## [Unreleased]`.
4. Use a clear, [Conventional Commit](https://www.conventionalcommits.org/) message
   (`fix:`, `feat:`, `docs:`, `chore:` …). This drives the changelog and releases.
5. Open the PR using the template; link the issue it closes.

## Commit & release conventions

We use Conventional Commits. Merged `feat:` and `fix:` commits are summarized in the
release notes. Releases are cut by maintainers by tagging `vX.Y.Z` (see
[`.github/workflows/release.yml`](./.github/workflows/release.yml)).

## Sign-off (DCO)

By contributing, you agree that your contribution is licensed under the project's
[MIT](./LICENSE) license. Please add a `Signed-off-by` line to your commits
(`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).

## Code of Conduct

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md). Be kind.
