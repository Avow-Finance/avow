# Listing the MCP server

The [MCP Registry](https://registry.modelcontextprotocol.io) is where MCP clients and the registries built on it look for servers, so Avow's server belongs there from the next release on. `server.json` at the root of this repo is the listing. A maintainer publishes it by hand after a release, and nothing in CI publishes it.

## What the listing says

It lists the `avow-sandbox` package on npm, run over stdio as `npx avow-sandbox mcp --dir <folder>`, the same server `avow-sandbox mcp add` sets up. The one value a person fills in is the agent's folder, where the server keeps the agent's key. The registry's schema describes a named argument as `--flag={value}`, and the server reads only `--dir <folder>`, so the listing passes `--dir` and the folder as two positional arguments, which a client inserts as written. `packages/sdk/src/node/server-json.test.ts` holds the listing to the package's real command and to what `mcp add` passes, and starts the server from it.

## Before the first listing

- The registry takes a listing only when the npm package it names carries an `mcpName` in its `package.json` equal to the listing's `name`. `packages/avow-sandbox/package.json` gained that field after 0.12.0 was published, so 0.12.0 can't be listed, and the first listing waits for the next release.
- The name `io.github.Avow-Finance/avow-sandbox` sits in the GitHub organization's namespace. The registry grants that namespace to a person who logs in with GitHub and is an Owner of the Avow-Finance organization.

## After each release

1. The version bump raises `version` and `packages[0].version` in `server.json` along with every public package. The SDK's tests fail until it does.
2. Once the Release workflow has published, check npm has the version with its name. `npm view avow-sandbox@<version> mcpName` prints `io.github.Avow-Finance/avow-sandbox`.
3. Install `mcp-publisher` with `brew install mcp-publisher`, or from the [registry's releases](https://github.com/modelcontextprotocol/registry/releases).
4. From the root of this repo, checked out at the release commit, run these in order.

   ```sh
   mcp-publisher validate
   mcp-publisher login github
   mcp-publisher publish
   ```

   `login github` prints a code to enter at https://github.com/login/device. Sign in as an Owner of Avow-Finance and authorize the app.
5. Check the listing appeared. This search lists the new version.

   ```sh
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Avow-Finance/avow-sandbox"
   ```

A published version can never be changed or published again, so a fix to the listing waits for the next version. The registry is in preview and warns that it may reset its data, so check the listing is still there after each release.

The registry also takes a login from a GitHub Actions workflow (`mcp-publisher login github-oidc`) and a login that proves a domain through DNS or HTTPS, which would put the server under that domain's namespace. Either one is a change for a maintainer to decide on, since the first adds a workflow and the second changes the server's name.

## Other places to list

Each of these is a decision for a maintainer, and nothing here is submitted.

- **[Claude's directory](https://claude.com/docs/directory/publish).** It takes remote MCP servers as connectors and plugin bundles from public GitHub repositories. It no longer takes local servers packaged as desktop extensions (`.mcpb`), and it takes a skill only inside a plugin. Avow's server runs locally, so it would go in a plugin bundle with the skill. A bundle needs `.claude-plugin/plugin.json`, a README of at least 40 words and a license in its folder, and an `npx` command pinned to an exact version, which a reviewer always reads before it goes live ([checklist](https://claude.com/docs/plugins/pre-submission-checklist)). The submitter needs a paid Claude plan, and on Team or Enterprise an Owner's role, and accepts seven policy statements, financial transactions among them. A bundle also has to settle which folder its server keeps the agent's key in.
- **[The GitHub MCP Registry](https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/).** VS Code installs servers from it. It reads servers published to the MCP Registry, and GitHub asks for inclusion by email to partnerships@github.com once a server is published there.
- **[Cursor](https://cursor.com/docs/mcp).** Its docs point to the Cursor Marketplace for official plugins and to cursor.directory for community servers, and say nothing about how to be listed in either.
- **Agent Skills.** The [Agent Skills format](https://agentskills.io/specification) defines `SKILL.md` and no registry. Clients find skills in a project's `.agents/skills/` folder or a folder of their own such as `.claude/skills/` ([client guide](https://agentskills.io/client-implementation/adding-skills-support)). `skills/avow-commitments` meets the format, with a name that matches its folder and a description under 1024 characters, so for now a person copies the folder, or a plugin bundle carries it.
- **The desktop extension.** The MCP Registry takes an `.mcpb` file from a GitHub release as a second package, with its SHA-256 in the listing ([package types](https://modelcontextprotocol.io/registry/package-types)). The Release workflow builds the file afresh for each version, so its hash would have to be read from that release before each listing.
