# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fhria5/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fhria5/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: REST v3, git smart HTTP (protocol v2 + v0), GraphQL and MCP over one deterministic in-memory store. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
npm start
```

The entry binds an ephemeral port, registers it with the trial environment from `MAKEFUN_ENV_URL`, serves until the environment says the trial is done, then exits 0. It needs `MAKEFUN_SHOP_TOKEN` (the trial bearer token) in the environment. Node 22.18+ or newer, standard library only, no dependencies, no git binary, no outside service.

## What it implements

- **REST v3** under `/api/v3`: repos, branches, commits, contents (create/update/delete with SHA checks), labels, issues, comments, pull requests (create, files, squash merge with conflict detection), pagination with `Link` headers, `X-GitHub-Request-Id` on every reply.
- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (ls-refs, fetch with depth/shallow/unshallow) with a v0 fallback, receive-pack v0 with per-ref fast-forward checks and report-status. Packfiles are written and read from scratch (full objects on write; ofs/ref deltas resolve on read).
- **GraphQL** at `/api/graphql`: a real parser, validator and executor for the gh-style documents (viewer, repository, issues with cursor pagination and ordering, pull requests, `__type` introspection, `node(id:)`, mutations, batched operations).
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, `server/discover` (revision 2026-07-28) and the legacy `initialize` handshake, eight tools (`create_repo`, `get_repo`, `create_issue`, `get_issue`, `list_issues`, `create_pull_request`, `list_pull_requests`, `merge_pull_request`).
- **Determinism**: no wall clock and no unseeded randomness anywhere — every timestamp comes from `MAKEFUN_TRIAL_NOW` plus a monotonic counter, so two runs on the same instance produce identical state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s2z411t3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
