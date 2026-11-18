import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_TOOLS } from './mcp.js'

const SKILL = readFileSync(
  join(import.meta.dirname, '../../../../skills/avow-commitments/SKILL.md'),
  'utf8',
)

describe('the agent skill', () => {
  it('names every tool the MCP server has, and none it lacks', () => {
    const named = new Set([...SKILL.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))
    const tools = MCP_TOOLS.map((t) => t.name)
    for (const tool of tools) expect(named, `the skill should mention ${tool}`).toContain(tool)
    // Words in backticks that look like tools have to be tools, or one of the few other names.
    const others = new Set(['payee'])
    for (const name of named) {
      if (name && !others.has(name)) expect(tools as readonly string[]).toContain(name)
    }
  })

  it('opens with the name and a description an agent can match on', () => {
    expect(SKILL).toMatch(/^---\nname: avow-commitments\ndescription: Use when .+\n---\n/)
  })
})

describe('the tools reference', () => {
  it('lists every tool the MCP server has', () => {
    const page = readFileSync(
      join(import.meta.dirname, '../../../../fern/docs/pages/tools.mdx'),
      'utf8',
    )
    for (const tool of MCP_TOOLS) expect(page).toContain(`| \`${tool.name}\` |`)
  })
})
