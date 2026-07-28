<div align="center">

# Skaftor CLI

**Drive AI-native software delivery from your terminal.**

`skaftor` is a zero-dependency command-line client for [Skaftor](https://skaftor.com) —
the system of record for AI-native software delivery. It's a thin wrapper over your
project's **MCP server** (the same surface coding agents like Cursor and Claude Code
connect to), so you can move work orders, pull execution context, and open pull
requests without leaving the shell.

[![npm version](https://img.shields.io/npm/v/skaftor?color=3448ff&label=npm)](https://www.npmjs.com/package/skaftor)
[![CI](https://github.com/skaftor/skaftor-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/skaftor/skaftor-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![Docs](https://img.shields.io/badge/docs-skaftor.com-3448ff)](https://skaftor.com/docs)

[Website](https://skaftor.com) · [Docs](https://skaftor.com/docs/cli/reference) · [What is Skaftor?](https://skaftor.com/what-is-skaftor) · [Discussions](https://github.com/skaftor/skaftor-cli/discussions)

</div>

---

## Why

When AI agents write most of the code, the bottleneck moves from typing to
**coordination, governance, and memory** — the [Orchestration Gap](https://skaftor.com/blog/the-orchestration-gap).
Skaftor closes it: intent becomes agent-executable **work orders**, agents are
orchestrated over MCP, every change is governed, and the whole history is remembered
in an engineering memory graph. This CLI is the terminal front-end to that workflow.

## Install

Needs **Node.js 18+**. No other dependencies.

```bash
# via the hosted installer (drops `skaftor` into ~/.local/bin)
curl -fsSL https://app.skaftor.com/install | sh

# or via npm
npm install -g skaftor
```

## Connect

Get your **personal MCP link** from the app: open a project → a work order →
_"connect your coding agent"_ and copy the URL. Then:

```bash
skaftor login "https://app.skaftor.com/api/mcp/<projectId>?dev=<token>"
skaftor context        # list connections, ● marks the active one
skaftor whoami
```

The connection is saved to `~/.skaftor/config.json` (`chmod 600` — it holds a token).

## Work orders

```bash
skaftor wo next                       # the recommended next task for you
skaftor wo mine                       # everything assigned to you
skaftor wo list --status ready        # filter by status or --phase
skaftor wo show   AUTH-02             # full spec + acceptance criteria + manifest
skaftor wo plan   AUTH-02             # decision engine: repo, files, reuse, impact
skaftor wo manifest AUTH-02           # the full execution manifest as one JSON payload

skaftor wo start  AUTH-02 --branch feature/auth-2
skaftor wo ask    AUTH-02 "Should partial reversals be idempotent?"
skaftor wo done   AUTH-02 --pr https://github.com/acme/repo/pull/42 \
                  --summary "Implemented core path" --ide "Claude Code"
```

Full command reference: **[skaftor.com/docs/cli/reference](https://skaftor.com/docs/cli/reference)**.

## How it works

The CLI speaks **JSON-RPC 2.0** to your project's MCP server at
`<origin>/api/mcp/<projectId>?dev=<token>` — the identical surface coding agents use.
That means the CLI, Cursor, and Claude Code all see the same work orders, the same
execution context, and the same governance. Point it at a self-hosted instance with
`SKAFTOR_URL=https://your-host`.

## Contributing

Issues and PRs welcome — see **[CONTRIBUTING.md](./CONTRIBUTING.md)** and our
**[Code of Conduct](./CODE_OF_CONDUCT.md)**. Good first issues are labeled
[`good first issue`](https://github.com/skaftor/skaftor-cli/labels/good%20first%20issue).

## Security

Found a vulnerability? Please follow our [Security Policy](./SECURITY.md) — do **not**
open a public issue for security reports.

## License

[MIT](./LICENSE) © Skaftor
