import { FACTORY_ABI as VERIFIER_FACTORY_ABI } from '@avow-finance/verifier'
import { decodeFunctionData, encodeErrorResult, getAbiItem, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  ADMINISTRATOR_ABI,
  approveSupplierCall,
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
})
