import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addToClient,
  type ClientDeps,
  claudeDesktopConfig,
  isMcpClient,
  mcpServersJson,
  type ServerLaunch,
} from './mcp-clients.js'

const launch: ServerLaunch = {
  name: 'avow-sandbox',
  command: '/usr/bin/node',
  args: ['/srv/mcp.js', '--dir', '/work/agent'],
}
const r = { dir: '/work/agent', next: 'ask it to connect to your Avow business' }

/** A machine in memory, which records the commands run and the files written. */
function machineWith(files: Record<string, string> = {}, ok = true) {
  const ran: string[][] = []
  const written: Record<string, string> = {}
  const backedUp: string[] = []
  const deps: ClientDeps = {
    run(command, args) {
      ran.push([command, ...args])
      return ok
    },
    read: (file) => written[file] ?? files[file] ?? null,
    write(file, text) {
      written[file] = text
    },
    backup: (file) => backedUp.push(file),
    home: '/home/dev',
    platform: 'linux',
    appData: undefined,
  }
  return { deps, ran, written, backedUp }
}

describe('adding the MCP server to a client', () => {
  it("runs Claude Code's and Codex's own commands, replacing an earlier entry", () => {
    for (const client of ['claude-code', 'codex'] as const) {
      const m = machineWith()
      const tool = client === 'codex' ? 'codex' : 'claude'
      expect(addToClient(client, launch, r, m.deps).ok).toBe(true)
      expect(m.ran).toEqual([
        [tool, 'mcp', 'remove', 'avow-sandbox'],
        [
          tool,
          'mcp',
          'add',
          'avow-sandbox',
          '--',
          '/usr/bin/node',
          '/srv/mcp.js',
          '--dir',
          '/work/agent',
        ],
      ])
    }
  })

  it('adds a stdio server to VS Code through its own command', () => {
    const m = machineWith()
    addToClient('vscode', launch, r, m.deps)
    const [command, flag, spec] = m.ran[0] ?? []
    expect([command, flag]).toEqual(['code', '--add-mcp'])
    expect(JSON.parse(spec ?? '')).toEqual({
      name: 'avow-sandbox',
      type: 'stdio',
      command: '/usr/bin/node',
      args: ['/srv/mcp.js', '--dir', '/work/agent'],
    })
  })

  it('gives the exact line to run when a client command fails', () => {
    const m = machineWith({}, false)
    const added = addToClient('codex', launch, r, m.deps)
    expect(added.ok).toBe(false)
    expect(added.message).toContain('"codex" "mcp" "add" "avow-sandbox" "--" "/usr/bin/node"')
  })

  it("writes Cursor's project file, keeping every other server and a copy of the old file", () => {
    const file = join('/work/agent', '.cursor', 'mcp.json')
    const m = machineWith({ [file]: JSON.stringify({ mcpServers: { other: { command: 'x' } } }) })
    expect(addToClient('cursor', launch, r, m.deps).ok).toBe(true)
    expect(JSON.parse(m.written[file] ?? '')).toEqual({
      mcpServers: {
        other: { command: 'x' },
        'avow-sandbox': { command: '/usr/bin/node', args: ['/srv/mcp.js', '--dir', '/work/agent'] },
      },
    })
    expect(m.backedUp).toEqual([file])
  })

  it("leaves a config file that isn't JSON alone and says what to add", () => {
    const file = claudeDesktopConfig({ home: '/home/dev', platform: 'linux', appData: undefined })
    const m = machineWith({ [file]: 'not json' })
    const added = addToClient('claude-desktop', launch, r, m.deps)
    expect(added.ok).toBe(false)
    expect(added.message).toContain('"mcpServers"')
    expect(m.written).toEqual({})
  })

  it("finds Claude Desktop's file on each platform", () => {
    expect(
      claudeDesktopConfig({ home: '/Users/dev', platform: 'darwin', appData: undefined }),
    ).toBe('/Users/dev/Library/Application Support/Claude/claude_desktop_config.json')
    expect(claudeDesktopConfig({ home: '/home/dev', platform: 'linux', appData: undefined })).toBe(
      '/home/dev/.config/Claude/claude_desktop_config.json',
    )
  })

  it('prints the block any other client reads, and knows only the clients it sets up', () => {
    expect(JSON.parse(mcpServersJson(launch))).toEqual({
      mcpServers: {
        'avow-sandbox': { command: '/usr/bin/node', args: ['/srv/mcp.js', '--dir', '/work/agent'] },
      },
    })
    expect(isMcpClient('cursor')).toBe(true)
    expect(isMcpClient('windsurf')).toBe(false)
    expect(isMcpClient(undefined)).toBe(false)
  })
})
