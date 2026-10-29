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

## Code we keep out

Every review checks a change for these nine problems, and a finding gets fixed before the change merges.

- **Implicit coupling.** When one module relies on another's format, field names, setting names or ordering, a shared type or a test pins that contract.
- **Layer-first folders.** Code is grouped by feature, so a change to one feature stays in one place.
- **Duplication.** Each rule, constant, ABI, encoding and helper lives in one place, and everything else imports it.
- **Representable illegal states.** Types make forbidden combinations impossible to write, with unions and branded types.
- **God files.** A file owns one responsibility, and gets split when it takes on a second.
- **Shotgun surgery.** A conceptual change, such as a new message type, request field or setting, lands in one place, or a compile error names every other place it has to go.
- **Layering violations.** Dependencies point one way. `spec` depends on no other package, packages import each other only through their entry points, and core logic doesn't depend on HTTP or the chain client.
- **Pass-through wrappers.** A function that only forwards a call gets removed.
- **Validation away from the boundary.** Input becomes a typed value where it enters, whether from HTTP, the environment, a file or the chain, and an error surfaces where it happens.

## Packages

Each package lives in `packages/`. Packages stay marked private until their first release, so nothing is published by accident.

## Words we use

Product text uses reserve, commitment, charge, dispute and release. It never uses bond, coverage, premium, claim or guarantee.

## License

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
