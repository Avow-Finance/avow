import { describe, expect, it } from 'vitest'
import { MCP_TOOLS } from './mcp.js'
import { SLICE_TOOL_DEFS, SLICE_TOOLS } from './mcp-slices.js'

describe("the MCP server's tools for workers", () => {
  it('serves delegate, slices and end_slice, and nothing that narrows or widens another way', () => {
    expect(SLICE_TOOL_DEFS.map((t) => t.name)).toEqual([...SLICE_TOOLS])
    for (const name of SLICE_TOOLS) expect(MCP_TOOLS.map((t) => t.name)).toContain(name)
  })

  it("says wherever a slice's limits show that the SDK and Avow alone hold them", () => {
    for (const name of ['delegate', 'slices'] as const) {
      const tool = SLICE_TOOL_DEFS.find((t) => t.name === name)
      expect(tool?.description).toContain('held by the SDK and Avow only')
    }
  })

  it('marks ending a worker destructive, and only reading them read-only', () => {
    const hint = (name: string) => SLICE_TOOL_DEFS.find((t) => t.name === name)?.annotations
    expect(hint('end_slice')).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    expect(hint('slices')).toMatchObject({ readOnlyHint: true })
    expect(hint('delegate')).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  })
})
