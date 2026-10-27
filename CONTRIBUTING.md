# Contributing to Avow

Avow is pre-release, and the packages here change often. Issues and pull requests are welcome.

## Set up

You need Node 22.12 or later and pnpm 10.

```sh
pnpm install
pnpm check
```

`pnpm check` runs lint, the build, type checks and tests. `pnpm format` fixes formatting.

## Making a change

- Open a pull request against `main`. Every change needs passing CI and a review before it merges.
- A change that touches settlement or dispute rules, signing, keys, mandates, authority checks, permissions, deployment, or what this repo publishes also needs a maintainer's approval.
- Add or update tests with every change in behavior.
- Keep each pull request to one change.
- Never commit a key, token or `.env` file.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Packages

Each package lives in `packages/`. Packages stay marked private until their first release, so nothing is published by accident.

## Words we use

Product text uses reserve, commitment, charge, dispute and release. It never uses bond, coverage, premium, claim or guarantee.

## License

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
