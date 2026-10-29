import { describe, expect, it } from 'vitest'
import {
  COMMITMENT_STATES,
  CONTESTED_STATES,
  type CommitmentState,
  canMove,
  ENDINGS,
  isContested,
  isEnding,
  OUTCOME_ENDINGS,
  TRANSITIONS,
} from './commitment.js'

/** Every state reachable from `start`, itself included, without passing through `avoid`. */
function reachable(start: CommitmentState, avoid?: CommitmentState): Set<CommitmentState> {
  const seen = new Set<CommitmentState>([start])
  const queue: CommitmentState[] = [start]
  for (let s = queue.shift(); s; s = queue.shift()) {
    for (const next of TRANSITIONS[s]) {
      if (next !== avoid && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

describe('commitment states', () => {
  it('has 11 states and 4 endings', () => {
    expect(COMMITMENT_STATES).toHaveLength(11)
    expect(ENDINGS).toEqual(['expired', 'released', 'charged', 'resolved'])
  })

  it('lets an ending move nowhere', () => {
    for (const end of ENDINGS) expect(TRANSITIONS[end]).toEqual([])
  })

  it('follows the state diagram', () => {
    expect(canMove('draft', 'draft')).toBe(true)
    expect(canMove('draft', 'agreed')).toBe(true)
    expect(canMove('agreed', 'awaiting_approval')).toBe(true)
    expect(canMove('agreed', 'expired')).toBe(true)
    expect(canMove('awaiting_approval', 'reserved')).toBe(true)
    expect(canMove('awaiting_approval', 'expired')).toBe(true)
    expect(canMove('reserved', 'accepted')).toBe(true)
    expect(canMove('reserved', 'released')).toBe(true)
    expect(canMove('accepted', 'released')).toBe(true)
    expect(canMove('accepted', 'charge_pending')).toBe(true)
    expect(canMove('charge_pending', 'charged')).toBe(true)
    expect(canMove('charge_pending', 'paused')).toBe(true)
    expect(canMove('paused', 'resolved')).toBe(true)
  })

  it('refuses shortcuts the diagram leaves out', () => {
    expect(canMove('draft', 'reserved')).toBe(false)
    expect(canMove('agreed', 'reserved')).toBe(false)
    expect(canMove('reserved', 'charge_pending')).toBe(false)
    expect(canMove('accepted', 'charged')).toBe(false)
    expect(canMove('paused', 'charged')).toBe(false)
    expect(canMove('released', 'reserved')).toBe(false)
  })

  it('lets every state reach an ending, so nothing can be stuck', () => {
    for (const start of COMMITMENT_STATES) {
      if (start === 'draft') continue // a draft nobody signs stays a draft, with nothing locked
      expect([...reachable(start)].some(isEnding), start).toBe(true)
    }
  })

  it('gives every outcome an ending, and every ending an outcome', () => {
    const endings = new Set(Object.values(OUTCOME_ENDINGS))
    expect([...endings].sort()).toEqual([...ENDINGS].sort())
  })

  it('carries a contest in exactly the states a commitment reaches only through one', () => {
    // A contest moves a pending charge to paused, and every state after paused keeps it.
    expect(TRANSITIONS.charge_pending).toContain('paused')
    const contested = reachable('paused')
    expect([...contested].sort()).toEqual([...CONTESTED_STATES].sort())
    // No contested state can be reached without the contest, so none can lack one.
    for (const state of reachable('draft', 'paused')) {
      expect(contested.has(state), state).toBe(false)
    }
    for (const state of COMMITMENT_STATES) {
      expect(isContested(state), state).toBe(contested.has(state))
    }
  })
})
