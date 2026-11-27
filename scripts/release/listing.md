# Listing the MCP server

The [MCP Registry](https://registry.modelcontextprotocol.io) is where MCP clients and the registries built on it look for servers, so Avow's server belongs there from the next release on. `server.json` at the root of this repo is the listing. A maintainer publishes it by hand after a release, and nothing in CI publishes it.

## What the listing says

It lists the `avow-sandbox` package on npm, run over stdio as `npx avow-sandbox mcp --dir <folder>`, the same server `avow-sandbox mcp add` sets up. The one value a person fills in is the agent's folder, where the server keeps the agent's key. The registry's schema describes a named argument as `--flag={value}`, and the server reads only `--dir <folder>`, so the listing passes `--dir` and the folder as two positional arguments, which a client inserts as written. `packages/sdk/src/node/server-json.test.ts` holds the listing to the package's real command and to what `mcp add` passes, and starts the server from it.

## Before the first listing

- The registry takes a listing only when the npm package it names carries an `mcpName` in its `package.json` equal to the listing's `name`. `packages/avow-sandbox/package.json` gained that field after 0.12.0 was published, so 0.12.0 can't be listed, and the first listing waits for the next release.
- The name `io.github.Avow-Finance/avow-sandbox` sits in the GitHub organization's namespace. The registry grants that namespace only to an Owner of the Avow-Finance organization, and only when it can read the organization's roles. The browser login can't do that for an organization, so an Owner logs in with a personal access token.
- The token is a classic one with the `read:org` scope, or a fine-grained one for Avow-Finance with Organization permissions, Members, read-only. It needs no repository access. A registry login from it can publish or overwrite any `io.github.Avow-Finance/*` server, so make it short-lived, revoke it after the publish, and never store it as a repository secret.

## After each release

1. The version bump raises `version` and `packages[0].version` in `server.json`, and the server's own version in `packages/sdk/src/node/mcp.ts`, along with every public package. The SDK's tests fail until it does.
2. Once the Release workflow has published, check npm has the version with its name. `npm view avow-sandbox@<version> mcpName` prints `io.github.Avow-Finance/avow-sandbox`.
3. Install `mcp-publisher` with `brew install mcp-publisher`, or from the [registry's releases](https://github.com/modelcontextprotocol/registry/releases).
4. From the root of this repo, checked out at the release commit, run these in order.

   ```sh
   mcp-publisher validate
   mcp-publisher login github --token <token>
   mcp-publisher publish
   ```

   Pass the Owner's token described above, and revoke it once the listing shows.
5. Check the listing appeared. This search lists the new version.

   ```sh
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Avow-Finance/avow-sandbox"
   ```

A published version can never be changed or published again, so a fix to the listing waits for the next version. The registry is in preview and warns that it may reset its data, so check the listing is still there after each release.

A workflow that publishes with GitHub Actions' own identity (`mcp-publisher login github-oidc`) could later replace the token. It would add a workflow, so it waits for a maintainer's approval.
