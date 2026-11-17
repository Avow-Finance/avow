# Avow sandbox for Claude Desktop

This package packs the sandbox MCP server from `@avow-finance/sdk` as a Claude Desktop extension, `dist/avow-sandbox.mcpb`, which a person installs with a double-click. The Release workflow attaches it to each GitHub release, so [the latest one](https://github.com/Avow-Finance/avow/releases/latest/download/avow-sandbox.mcpb) is always one link away.

`pnpm build` bundles the server and everything it imports into `server/index.js` with esbuild, writes the manifest from the server's own tool list, and packs the bundle with `mcpb pack`. The extension carries no `node_modules`, and Claude Desktop runs it with the Node it ships.

At install, Claude Desktop asks for an agent folder, and the server keeps the agent's key in `.avow` inside it. The bundle holds only what the server loads, and the SDK's graph test pins that none of that holds the business's key.

The tests open the packed file, check what it carries, and talk MCP to the bundled server from a folder outside the repo, so they fail if the bundle needs anything it doesn't carry.
