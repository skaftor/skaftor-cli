# Security Policy

We take the security of the Skaftor CLI and the Skaftor platform seriously. Thank you
for helping keep our users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report privately using one of:

- **GitHub Private Vulnerability Reporting** — use the **"Report a vulnerability"**
  button under this repository's **Security** tab (preferred).
- **Email** — **security@skaftor.com**. If you'd like, encrypt with our PGP key
  (published at https://skaftor.com/.well-known/security.txt).

Please include:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected version(s) — run `skaftor --version`.
- Any suggested remediation.

## What to expect

- **Acknowledgement** within **2 business days**.
- A **triage assessment** and severity rating within **7 business days**.
- Regular updates until resolution, and coordinated disclosure once a fix is available.
- Credit in the release notes / advisory, if you wish.

## Scope

In scope:

- The `skaftor` CLI in this repository (token handling, config file permissions,
  command injection, request handling).
- The way the CLI authenticates to and communicates with the MCP server.

Out of scope (report via https://skaftor.com/security or security@skaftor.com):

- The Skaftor web application and API (`app.skaftor.com`).
- Social-engineering, physical, or DoS testing.

## Handling of secrets

The CLI stores a personal dev token in `~/.skaftor/config.json` with mode `600`. If you
find any path where the token is logged, transmitted insecurely, or written elsewhere,
treat it as a security issue and report it privately.

## Supported versions

The latest published minor version receives security fixes. Please upgrade before
reporting to confirm the issue still reproduces.
