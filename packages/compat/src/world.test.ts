import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SKILL_PATH, serverEnv, systemPrompt, WORLD } from './world.js'

describe('the world each model runs in', () => {
  it('labels the business it makes as a test business', () => {
    expect(WORLD.name).toMatch(/test business/)
  })

  it("starts the server through the SDK's command, and hears the skill Avow ships after the server's instructions", () => {
    expect(existsSync(fileURLToPath(import.meta.resolve('@avow-finance/sdk/cli')))).toBe(true)
    const skill = readFileSync(SKILL_PATH, 'utf8')
    expect(skill.startsWith('---\nname: avow-commitments')).toBe(true)
    const prompt = systemPrompt('The server says this.')
    expect(prompt.startsWith('The server says this.\n\n# Avow commitments')).toBe(true)
    expect(prompt).not.toContain('name: avow-commitments')
    expect(prompt).toContain('split a booking to fit under one')
  })

  it("starts the server without the model's key, and with the proxy the machine needs", () => {
    const env = serverEnv(
      {
        OPENROUTER_API_KEY: 'sk-made-for-this-test',
        HTTPS_PROXY: 'http://proxy:8080',
        NODE_EXTRA_CA_CERTS: '/ca.crt',
        PATH: '/bin',
        UNSET: undefined,
      },
      ['OPENROUTER_API_KEY'],
    )
    expect(env).toEqual({
      HTTPS_PROXY: 'http://proxy:8080',
      NODE_EXTRA_CA_CERTS: '/ca.crt',
      PATH: '/bin',
    })
  })
})
