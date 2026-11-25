import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_PATHS } from './api.js'
import { API_OPERATIONS, openApiDocument } from './openapi.js'
import { SANDBOX_PATHS } from './sandbox.js'

const FILE = join(import.meta.dirname, '../../../fern/openapi/openapi.json')
const written = () => `${JSON.stringify(openApiDocument(), null, 2)}\n`

describe("the API reference's OpenAPI document", () => {
  it('matches the file the docs build from, so the reference never drifts from the schemas', () => {
    // AVOW_WRITE_OPENAPI=1 rewrites the file after a change to a route or a schema.
    if (process.env.AVOW_WRITE_OPENAPI === '1') writeFileSync(FILE, written())
    expect(readFileSync(FILE, 'utf8')).toBe(written())
  })

  it("passes every example through the schema its route's parser checks", () => {
    for (const op of API_OPERATIONS) {
      if (op.request?.example !== undefined) {
        expect(op.request.schema.safeParse(op.request.example).success, op.operationId).toBe(true)
      }
      if (op.answer.example !== undefined) {
        expect(op.answer.schema.safeParse(op.answer.example).success, op.operationId).toBe(true)
      }
    }
  })

  it('describes every path the SDK sends to, once, and nothing the API answers only to the console', () => {
    const paths = new Set(API_OPERATIONS.map((op) => `${op.method} ${op.path}`))
    expect(paths.size).toBe(API_OPERATIONS.length)
    const documented = API_OPERATIONS.map((op) => op.path)
    for (const path of [
      API_PATHS.enrollments,
      API_PATHS.reserveApprovals,
      API_PATHS.sponsorships,
      SANDBOX_PATHS.businesses,
      SANDBOX_PATHS.suppliers,
      SANDBOX_PATHS.businessChecks,
      SANDBOX_PATHS.businessCheck,
      SANDBOX_PATHS.topUps,
      SANDBOX_PATHS.agentRequests,
      SANDBOX_PATHS.openAgentRequests,
      SANDBOX_PATHS.mailboxOrders,
      SANDBOX_PATHS.mailboxInbox,
    ]) {
      expect(documented).toContain(path)
    }
    for (const route of [
      'supplier-authorizations',
      'cancellations',
      'start-requests',
      'start-receipts',
      'contest-statements',
    ]) {
      expect(documented).toContain(`/v1/commitments/{commitmentId}/${route}`)
    }
    expect(documented.some((p) => p.includes('/console/') || p.includes('/operator/'))).toBe(false)
  })

  it('lets anyone call only the status routes, a supplier profile and a decision unsigned', () => {
    // A decision carries the root key's signature over the request in its body, which is what
    // authorizes it, so it needs no signed request around it.
    const unsigned = API_OPERATIONS.filter((op) => op.signedBy === null).map((op) => op.operationId)
    expect(unsigned).toEqual(['health', 'ready', 'decideRequest', 'supplierProfile'])
  })
})
