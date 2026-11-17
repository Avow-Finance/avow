// Packs the sandbox MCP server as a Claude Desktop extension. esbuild bundles the SDK's server and
// everything it imports into one file, so the extension carries no node_modules, and the manifest
// lists the same tools the server answers with. The bundle holds exactly what the server loads, and
// the SDK's graph test pins that none of it holds the business's key. `mcpb pack` then zips the bundle into
// dist/avow-sandbox.mcpb, which a person installs with a double-click.

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { packExtension, validateManifest } from '@anthropic-ai/mcpb'
import { build } from 'esbuild'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const bundle = here('dist/bundle/')
const output = here('dist/avow-sandbox.mcpb')
const server = here('../sdk/dist/node/mcp.js')
const { version } = JSON.parse(readFileSync(here('../sdk/package.json'), 'utf8'))
const { MCP_TOOLS } = await import(server)

rmSync(here('dist'), { recursive: true, force: true })
mkdirSync(`${bundle}server`, { recursive: true })

await build({
  entryPoints: [server],
  outfile: `${bundle}server/index.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  // A dependency that still uses require finds it in an ES module bundle through this.
  banner: {
    js: "import { createRequire as avowCreateRequire } from 'node:module'; const require = avowCreateRequire(import.meta.url);",
  },
})

const manifest = {
  manifest_version: '0.3',
  name: 'avow-sandbox',
  display_name: 'Avow sandbox',
  version,
  description:
    "Lets Claude act as an agent for your Avow business on Tempo's testnet, within the limits your administrator approves.",
  long_description:
    "Claude connects to your business with a key it makes and keeps in an avow-agent folder in your home folder. You get a pairing code and a link, and your business's administrator approves on their phone with a passkey, setting the agent's limits. From then on Claude can book GPU capacity backed by a reserve in your business's own lock, and Avow and the chain refuse anything outside those limits. Everything runs on Tempo's Moderato testnet with test dollars.",
  author: { name: 'Avow', url: 'https://avow.finance' },
  homepage: 'https://avow.finance',
  documentation:
    'https://github.com/Avow-Finance/avow/blob/main/fern/docs/pages/connect-your-agent.mdx',
  support: 'https://github.com/Avow-Finance/avow/issues',
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js', '--dir', '${user_config.agent_folder}'],
    },
  },
  tools: MCP_TOOLS.map(({ name, description }) => ({ name, description })),
  keywords: ['avow', 'agents', 'commitments', 'tempo', 'testnet'],
  license: 'Apache-2.0',
  compatibility: { platforms: ['darwin', 'win32'], runtimes: { node: '>=22.12.0' } },
  user_config: {
    agent_folder: {
      type: 'directory',
      title: 'Agent folder',
      description:
        'Where this agent keeps its key, in a .avow folder inside it. Leave it as it is unless you run more than one agent, then give each a folder of its own. The key never leaves it, and Claude never shows it.',
      // Installing asks nothing, and the server makes the folder the first time it saves the key.
      default: '${HOME}/avow-agent',
      required: false,
    },
  },
}

writeFileSync(`${bundle}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
copyFileSync(here('icon.png'), `${bundle}icon.png`)
if (!validateManifest(`${bundle}manifest.json`)) throw new Error("The manifest isn't valid")
if (!(await packExtension({ extensionPath: bundle, outputPath: output, silent: true }))) {
  throw new Error("mcpb couldn't pack the extension")
}
console.log(`Packed ${output}`)
