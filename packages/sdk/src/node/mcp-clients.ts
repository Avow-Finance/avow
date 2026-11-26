import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The MCP clients `avow-sandbox mcp add` sets up itself. Any other takes `mcp config`. */
export const MCP_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'codex'] as const
export type McpClient = (typeof MCP_CLIENTS)[number]

export const isMcpClient = (name: string | undefined): name is McpClient =>
  (MCP_CLIENTS as readonly string[]).includes(name ?? '')

/** How a client starts the server: one stdio command against one agent's folder. */
export interface ServerLaunch {
  name: string
  command: string
  args: readonly string[]
}

/** What adding the server needs from the machine, which a test replaces. */
export interface ClientDeps {
  /** Runs a client's own command, inheriting the terminal, and says whether it succeeded. */
  run(command: string, args: readonly string[]): boolean
  read(file: string): string | null
  write(file: string, text: string): void
  backup(file: string): void
  home: string
  platform: NodeJS.Platform
  appData: string | undefined
}

export const machine: ClientDeps = {
  run(command, args) {
    const result = spawnSync(command, [...args], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    return !result.error && result.status === 0
  },
  read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
  write(file, text) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  },
  backup: (file) => copyFileSync(file, `${file}.bak`),
  home: homedir(),
  platform: process.platform,
  appData: process.env.APPDATA,
}

/** Where Claude Desktop keeps its MCP servers on this platform. */
export function claudeDesktopConfig(deps: Pick<ClientDeps, 'home' | 'platform' | 'appData'>) {
  if (deps.platform === 'darwin') {
    return join(deps.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (deps.platform === 'win32') {
    return join(
      deps.appData ?? join(deps.home, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    )
  }
  return join(deps.home, '.config', 'Claude', 'claude_desktop_config.json')
}

/**
 * The `mcpServers` block most MCP clients read, Cursor, Claude Desktop and Windsurf among them,
 * for a client `mcp add` doesn't set up itself.
 */
export function mcpServersJson(launch: ServerLaunch): string {
  const entry = { command: launch.command, args: [...launch.args] }
  return `${JSON.stringify({ mcpServers: { [launch.name]: entry } }, null, 2)}\n`
}

/**
 * Adds the server to a JSON file of `mcpServers`, keeping every other server there and a copy of
 * the file as it was. A file that isn't JSON is left alone, and the answer says so.
 */
function addToFile(file: string, launch: ServerLaunch, deps: ClientDeps): string | null {
  const before = deps.read(file)
  let config: { mcpServers?: Record<string, unknown> } = {}
  if (before !== null) {
    try {
      config = JSON.parse(before) as typeof config
    } catch {
      return `${file} isn't JSON, so it was left as it is. Add this to it yourself:\n\n${mcpServersJson(launch)}`
    }
    deps.backup(file)
  }
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    [launch.name]: { command: launch.command, args: [...launch.args] },
  }
  deps.write(file, `${JSON.stringify(config, null, 2)}\n`)
  return null
}

/** What adding the server told the person, and whether it worked. */
export interface Added {
  ok: boolean
  message: string
}

/**
 * Adds the server to one MCP client, against the agent's folder that `launch` names. A client
 * with a command of its own for this gets that command, and a client whose command fails gets the
 * exact line to run. `next` is what to ask the agent once the client has the server.
 */
export function addToClient(
  client: McpClient,
  launch: ServerLaunch,
  r: { dir: string; next: string },
  deps: ClientDeps = machine,
): Added {
  const fallback = (line: readonly string[]) =>
    `didn't take it. Run this in this folder yourself:\n\n  ${line.map((a) => JSON.stringify(a)).join(' ')}\n`
  switch (client) {
    case 'claude-code': {
      // An entry an earlier version added for this folder would stop the new one, so it goes
      // first. Removing one that isn't there fails quietly.
      deps.run('claude', ['mcp', 'remove', launch.name])
      const line = ['claude', 'mcp', 'add', launch.name, '--', launch.command, ...launch.args]
      return deps.run(line[0] as string, line.slice(1))
        ? { ok: true, message: `Added. Run claude in this folder and ${r.next}.` }
        : { ok: false, message: `Claude Code ${fallback(line)}` }
    }
    case 'codex': {
      deps.run('codex', ['mcp', 'remove', launch.name])
      const line = ['codex', 'mcp', 'add', launch.name, '--', launch.command, ...launch.args]
      return deps.run(line[0] as string, line.slice(1))
        ? { ok: true, message: `Added. Start Codex and ${r.next}.` }
        : { ok: false, message: `Codex ${fallback(line)}` }
    }
    case 'vscode': {
      const spec = JSON.stringify({
        name: launch.name,
        type: 'stdio',
        command: launch.command,
        args: [...launch.args],
      })
      const line = ['code', '--add-mcp', spec]
      return deps.run(line[0] as string, line.slice(1))
        ? { ok: true, message: `Added to VS Code. Open Copilot Chat in agent mode and ${r.next}.` }
        : { ok: false, message: `VS Code ${fallback(line)}` }
    }
    case 'cursor': {
      // The project's own file, so the server reaches this folder's agent in this project only.
      const file = join(r.dir, '.cursor', 'mcp.json')
      const problem = addToFile(file, launch, deps)
      return problem
        ? { ok: false, message: problem }
        : { ok: true, message: `Added to ${file}. Open this folder in Cursor and ${r.next}.` }
    }
    case 'claude-desktop': {
      const file = claudeDesktopConfig(deps)
      const problem = addToFile(file, launch, deps)
      return problem
        ? { ok: false, message: problem }
        : { ok: true, message: `Added to ${file}. Restart Claude Desktop and ${r.next}.` }
    }
  }
}
