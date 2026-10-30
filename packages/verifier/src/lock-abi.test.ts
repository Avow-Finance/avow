import { decodeEventLog, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { FACTORY_EVENTS_ABI, LOCK_EVENTS_ABI } from './lock-abi.js'

/*
 * Logs the demo factory on Moderato and its locks wrote, copied from the chain as the node
 * returned them, each with the transaction that wrote it. Each decodes with the events the
 * verifier defines only when every name, type and indexed flag matches the deployed contracts.
 */

// 0x0d99bbaa111268811fe87acbfefef6fbdb6c311f5bde4bb679824c2d5058be99, the factory's first lock.
const LOCK_CREATED = {
  topics: [
    '0x123cb70c03b577bbee808e51d756598c1e1f196b21fe1bf2a8003e46ff9413dd',
    '0x0000000000000000000000003c83faea7f2688317ddb9b90c9d6a99a8653dd4b',
  ],
  data: '0x000000000000000000000000101878b1adbfc7029cb41ffc19d00fb6b79151b4',
} as const

// 0xbd030cb2544d413c7c18c7cb8eb20830249b0811918888cb1dbcb58baed7b3cb
const RESERVED = {
  topics: [
    '0xf36ba36df45e75e552319000f505b89c8637a59e26c18643ea66beaa667109cf',
    '0x7451c3f2d47d8016dc0bb3582443e7e6a438656a1309134c8946705f843e9d74',
  ],
  data: '0x0000000000000000000000000000000000000000000000000000000000000000ff59c5f5442ff2855c2b18fe4759ade924276e99714ee80a95fb95987151e1d503c09fa8f880f5d0c35dce0fd1367067f81e2bb456abae725955278c4687a675000000000000000000000000000000000000000000000000000000001dcd6500000000000000000000000000aca6ebc06bc4d97e5a2f47f47868109540d2a585000000000000000000000000be0328b2d2d149cf12dbe4a064820f7d7e01dec30000000000000000000000000349f694fafff01133a2f8bd04ad5b9f25f8a29300000000000000000000000000000000790ef76140a0280c14236eca072dae52fd8a8cea0dbe51ea07c5aef38ed4d70ab919abf34921a7909c7c20eb6739de7c',
} as const

// 0xf5562583afa5228348514e3f5767f546546f85300a83960b4fab2c7aeddeb0c7
const RELEASED = {
  topics: [
    '0x32a2108a20d4afa499021bd5b1daf44770f493623f37ddb1d40a9bdd9aa5f1d6',
    '0x7451c3f2d47d8016dc0bb3582443e7e6a438656a1309134c8946705f843e9d74',
  ],
  data: '0x0000000000000000000000000000000000000000000000000000000000000000ff59c5f5442ff2855c2b18fe4759ade924276e99714ee80a95fb95987151e1d5000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000017009a21466b4a84f993d7f6159114e15ed077c21cb51021fd58bc79a8f332696000000000000000000000000000000000000000000000000000000001dcd6500',
} as const

// 0x13c7a16f4d9ab219c0447d954305a3a32e33f24c08b650791ebbd2878d6f08ae
const CHARGED = {
  topics: [
    '0x5c72a5f96473e1cf49a2fd051419e9ce5c2b43252a46a953b8ce85a9c472eb24',
    '0x72e9d5255b4c37303027a14a7d4c70f3d1fece4db2b620fca93a918b316e1a80',
  ],
  data: '0x00000000000000000000000000000000000000000000000000000000000000000b6f256bbf3d0c0770763a9bf88ac5d0b52535df4c6b94f5b9f1c85cffc96644000000000000000000000000000000000000000000000000000000000ee6b280af68e27409d46e79c3213cb3533ceb951090329fc0cc280001ce72e0b0c8b7b4',
} as const

// 0xec484d1b4a56cfc6832bb513f71317ad263c75d577ed6269733087eeaef1f162, a trigger on a contested
// charge nobody ruled on, past its day-90 default.
const RESOLVED = {
  topics: [
    '0x4050c47d8b6e9bdd42f8e0d92377b971a1e4dc2ad0ea6cc3017883593079f3c9',
    '0xf83f4bef595fed73ad1c7998d48512dc1060784a6c13da0a7cbefba37404128b',
  ],
  data: '0x000000000000000000000000000000000000000000000000000000000000000041eb91411113a40c6359b033ddd9676261c2d73605506b80d8e891dc052142230000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ee6b280000000000000000000000000000000000000000000000000000000000ee6b280da697e901ae2246460db59a69afcf6399ef5755d0e05eca89cb53642032bc34f',
} as const

type RawLog = { topics: readonly [Hex, ...Hex[]]; data: Hex }

const lockEvent = (log: RawLog) =>
  decodeEventLog({ abi: LOCK_EVENTS_ABI, topics: [...log.topics], data: log.data, strict: true })

describe("the factory's event", () => {
  it('decodes the LockCreated log the demo factory wrote for its first lock', () => {
    const { eventName, args } = decodeEventLog({
      abi: FACTORY_EVENTS_ABI,
      topics: [...LOCK_CREATED.topics],
      data: LOCK_CREATED.data,
      strict: true,
    })
    expect(eventName).toBe('LockCreated')
    expect(args).toEqual({
      account: '0x3C83fAEa7f2688317dDB9b90c9d6A99A8653DD4b',
      lock: '0x101878B1adBfC7029Cb41FFc19D00Fb6b79151B4',
    })
  })
})

describe("the lock's events that open and end a side", () => {
  it('decode the Reserved, Released, Charged and Resolved logs the demo locks wrote', () => {
    const reserved = lockEvent(RESERVED)
    expect(reserved.eventName).toBe('Reserved')
    expect(reserved.args).toMatchObject({
      commitmentId: '0x7451c3f2d47d8016dc0bb3582443e7e6a438656a1309134c8946705f843e9d74',
      side: 0,
      amount: 500_000_000n,
      approvalNonce: 0x790ef76140a0280c14236eca072dae52n,
    })
    const released = lockEvent(RELEASED)
    expect(released.eventName).toBe('Released')
    // The same side, given back whole once the supplier consented.
    expect(released.args).toMatchObject({
      commitmentId: reserved.args.commitmentId,
      side: 0,
      cause: 2,
      reason: 1,
      returned: 500_000_000n,
    })
    const charged = lockEvent(CHARGED)
    expect(charged.eventName).toBe('Charged')
    expect(charged.args).toMatchObject({ side: 0, amount: 250_000_000n })
    // Nobody ruled on the contested $500 no-show charge, so day 90 split it at the lock's 50%.
    const resolved = lockEvent(RESOLVED)
    expect(resolved.eventName).toBe('Resolved')
    expect(resolved.args).toMatchObject({
      commitmentId: '0xf83f4bef595fed73ad1c7998d48512dc1060784a6c13da0a7cbefba37404128b',
      side: 0,
      byRuling: false,
      toSupplier: 250_000_000n,
      toBusiness: 250_000_000n,
    })
  })
})
