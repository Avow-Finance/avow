import { MODERATO_RPC_URL } from '@avow-finance/sdk'
import { describe, expect, it } from 'vitest'
import { keeperSettings } from './settings.js'

const FACTORY = '0x9b518c24f9aa9272e20fa78aedc83b1f00b991a9'

describe("the keeper's settings", () => {
  it('reads the factory and its start block, and looks back 14 days through the public RPC by default', () => {
    expect(
      keeperSettings({ AVOW_FACTORY: ` ${FACTORY} `, AVOW_FACTORY_START_BLOCK: '41503611' }),
    ).toEqual({
      factory: '0x9B518c24F9aa9272e20fa78aeDC83b1F00b991a9',
      startBlock: 41_503_611n,
      lookback: 14n * 86_400n,
      rpcUrl: MODERATO_RPC_URL,
    })
  })

  it('takes another lookback and RPC', () => {
    const settings = keeperSettings({
      AVOW_FACTORY: FACTORY,
      AVOW_FACTORY_START_BLOCK: '1',
      LOOKBACK_DAYS: '3',
      RPC_URL: 'http://127.0.0.1:8545',
    })
    expect(settings.lookback).toBe(3n * 86_400n)
    expect(settings.rpcUrl).toBe('http://127.0.0.1:8545')
  })

  it('names every setting that is missing or wrong', () => {
    expect(() => keeperSettings({})).toThrow(
      'These settings are missing or wrong: AVOW_FACTORY, AVOW_FACTORY_START_BLOCK',
    )
    expect(() =>
      keeperSettings({
        AVOW_FACTORY: '0x1234',
        AVOW_FACTORY_START_BLOCK: '-5',
        LOOKBACK_DAYS: '0',
      }),
    ).toThrow(
      'These settings are missing or wrong: AVOW_FACTORY, AVOW_FACTORY_START_BLOCK, LOOKBACK_DAYS',
    )
  })
})
