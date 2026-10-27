# Working in this repo

This repo holds Avow's open packages: the commitment schema, the verifier a supplier runs, the SDK and the MCP server. [CONTRIBUTING.md](CONTRIBUTING.md) applies to every change, from a person or a coding agent.

## Commands

- `pnpm install` installs everything.
- `pnpm check` runs lint, the build, type checks and tests. Packages import each other's built output, so the build runs first. Run it before every commit.
- `pnpm format` fixes formatting.
- `AVOW_LIVE_TEMPO=1 pnpm check` also runs the live tests on Tempo's Moderato testnet. They need no secrets, since they make their keys at run time and fund them from the testnet faucet.

## Rules

- Every change goes through a pull request, with tests for any change in behavior. It needs passing CI and a review before it merges.
- A change that touches settlement or dispute rules, signing, keys, mandates, authority checks, permissions, deployment, or what this repo publishes also needs a maintainer's approval.
- Testnet only. Nothing here moves real money.
- Never commit keys, tokens or `.env` files. Tests make their keys at run time.
- Packages stay `"private": true` until their first release.
- Code comments explain themselves and don't point at documents outside this repo.
- Product text uses reserve, commitment, charge, dispute and release, and never bond, coverage, premium, claim or guarantee.
- Writing for people (READMEs, docs, release notes) uses no em dashes, no "not X, it's Y" contrasts and no colon reveals, and takes a position.
