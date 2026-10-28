import { getAbiItem, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { RESERVE_ABI, RESERVE_SELECTOR } from './lock.js'

describe("the lock's reserve function", () => {
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
