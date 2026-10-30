import { type LockedBacking, FACTORY_ABI as VERIFIER_FACTORY_ABI } from '@avow-finance/verifier'
import { decodeFunctionData, encodeErrorResult, getAbiItem, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  ADMINISTRATOR_ABI,
  approveSupplierCall,
  cancelFreeCall,
  cancelsFree,
  createLockCall,
  FACTORY_ABI,
  RESERVE_ABI,
  RESERVE_SELECTOR,
  TRIGGER_ABI,
  triggerCall,
} from './lock.js'

describe("the lock's trigger", () => {
  const LOCK = '0x00000000000000000000000000000000000010c4'
  const COMMITMENT = `0x${'7a'.repeat(32)}` as const

  it('has the selector the compiled testnet lock dispatches trigger on', () => {
    const selector = toFunctionSelector(getAbiItem({ abi: TRIGGER_ABI, name: 'trigger' }))
    expect(selector).toBe(toFunctionSelector('trigger(bytes32,uint8)'))
    // The deployed locks' dispatchers carry it, so a change to the copy can't slip by.
    expect(selector).toBe('0x1604f9c9')
  })

  it('names the error the testnet lock reverts with when no step is due', () => {
    // The data a deployed lock returned for a side that had already ended.
    expect(encodeErrorResult({ abi: TRIGGER_ABI, errorName: 'NothingDue' })).toBe('0x86fdb19c')
  })

  it('sends each side to its lock with the code the lock stores for it', () => {
    for (const [side, code] of [
      ['buyer', 0],
      ['supplier', 1],
    ] as const) {
      const call = triggerCall(LOCK, COMMITMENT, side)
      expect(call.to).toBe(LOCK)
      expect(decodeFunctionData({ abi: TRIGGER_ABI, data: call.data }).args).toEqual([
        COMMITMENT,
        code,
      ])
    }
  })
})

describe("the lock's reserve function", () => {
  it('has the selector the compiled testnet lock dispatches reserve on', () => {
    // The deployed locks' dispatchers carry it, so a change to the copy can't slip by.
    expect(RESERVE_SELECTOR).toBe('0x10a5e004')
  })

  it('has the selector of reserve over the approval tuple and a signature', () => {
    expect(RESERVE_SELECTOR).toBe(
      toFunctionSelector(getAbiItem({ abi: RESERVE_ABI, name: 'reserve' })),
    )
    expect(toFunctionSelector(getAbiItem({ abi: RESERVE_ABI, name: 'reserve' }))).toBe(
      toFunctionSelector(
        'reserve((bytes32,uint8,address,uint256,address,address,address,uint64,uint64,uint64,uint64,uint64,(uint8,uint256,uint64)[],uint16,address,bytes32,bytes32,uint256,uint256,address,uint256,uint64),bytes)',
      ),
    )
  })
})

describe("the administrator's calls", () => {
  const LOCK = '0x00000000000000000000000000000000000010c4'
  const FACTORY = '0x9b518c24f9aa9272e20fa78aedc83b1f00b991a9'
  const ACCOUNT = '0x00000000000000000000000000000000000000b1'
  const SUPPLIER = '0x00000000000000000000000000000000000000c1'

  it("use the verifier's one factory ABI, which has every function either package calls", () => {
    expect(FACTORY_ABI).toBe(VERIFIER_FACTORY_ABI)
    expect(FACTORY_ABI.map((f) => toFunctionSelector(f)).sort()).toEqual(
      [
        toFunctionSelector('isLock(address)'),
        toFunctionSelector('createLock(address)'),
        toFunctionSelector('lockAddress(address)'),
      ].sort(),
    )
  })

  it('have the selectors of the compiled testnet lock and factory', () => {
    expect(
      toFunctionSelector(getAbiItem({ abi: ADMINISTRATOR_ABI, name: 'approveSupplier' })),
    ).toBe(toFunctionSelector('approveSupplier(address)'))
    expect(toFunctionSelector(getAbiItem({ abi: ADMINISTRATOR_ABI, name: 'cancelFree' }))).toBe(
      toFunctionSelector('cancelFree(bytes32,uint8)'),
    )
    expect(toFunctionSelector(getAbiItem({ abi: FACTORY_ABI, name: 'createLock' }))).toBe(
      toFunctionSelector('createLock(address)'),
    )
    expect(toFunctionSelector(getAbiItem({ abi: FACTORY_ABI, name: 'lockAddress' }))).toBe(
      toFunctionSelector('lockAddress(address)'),
    )
  })

  it("send each call to the contract it's for, with its one argument", () => {
    const created = createLockCall(FACTORY, ACCOUNT)
    expect(created.to).toBe(FACTORY)
    expect(decodeFunctionData({ abi: FACTORY_ABI, data: created.data }).args).toEqual([
      '0x00000000000000000000000000000000000000B1',
    ])
    const approved = approveSupplierCall(LOCK, SUPPLIER)
    expect(approved.to).toBe(LOCK)
    expect(decodeFunctionData({ abi: ADMINISTRATOR_ABI, data: approved.data }).args).toEqual([
      '0x00000000000000000000000000000000000000C1',
    ])
  })

  it("cancel the buyer's side of a commitment on the business's own lock", () => {
    const COMMITMENT = `0x${'5c'.repeat(32)}` as const
    const cancelled = cancelFreeCall(LOCK, COMMITMENT)
    expect(cancelled.to).toBe(LOCK)
    const { functionName, args } = decodeFunctionData({
      abi: ADMINISTRATOR_ABI,
      data: cancelled.data,
    })
    expect(functionName).toBe('cancelFree')
    // The lock files the buyer's side under 0.
    expect(args).toEqual([COMMITMENT, 0])
  })

  it('cancel free only while the lock takes it, by its state and the chain clock', () => {
    const FREE_CANCEL_BY = 1_800_000_000n
    const ZERO = `0x${'00'.repeat(32)}` as const
    const held = (change: Partial<LockedBacking> = {}): LockedBacking => ({
      state: 'accepted',
      token: '0x20c0000000000000000000000000000000000001',
      amount: 500_000_000n,
      held: 500_000_000n,
      payee: SUPPLIER,
      supplier: SUPPLIER,
      supplierSigner: SUPPLIER,
      freeCancelBy: FREE_CANCEL_BY,
      acceptBy: FREE_CANCEL_BY + 600n,
      chargeDeadline: FREE_CANCEL_BY + 3600n,
      contestWindow: 600n,
      releaseDate: FREE_CANCEL_BY + 3600n,
      charges: [],
      day90SupplierShareBps: 5000,
      arbiter: SUPPLIER,
      termsHash: ZERO,
      mandateHash: ZERO,
      approvalHash: ZERO,
      fundingKey: SUPPLIER,
      reportCount: 0,
      hasReport: false,
      hasRuling: false,
      ...change,
    })
    const open = FREE_CANCEL_BY - 1n
    expect(cancelsFree(held(), open)).toBe(true)
    expect(cancelsFree(held({ state: 'reserved' }), open)).toBe(true)
    expect(cancelsFree(held(), FREE_CANCEL_BY)).toBe(false)
    expect(cancelsFree(held({ hasReport: true, reportCount: 1 }), open)).toBe(false)
    for (const state of ['charge_pending', 'paused', 'released', 'charged', 'resolved'] as const) {
      expect(cancelsFree(held({ state }), open), state).toBe(false)
    }
  })
})
