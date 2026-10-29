import { TEMPO_MODERATO } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import {
  MODERATO_FEE_TOKEN,
  MODERATO_RPC_URL,
  moderatoClient,
  moderatoUsdToken,
} from './moderato.js'

describe('Moderato', () => {
  it('gives a client on its chain that pays fees in AlphaUSD, through the public RPC by default', () => {
    const client = moderatoClient()
    expect(client.chain.id).toBe(TEMPO_MODERATO)
    expect((client.chain as { feeToken?: unknown }).feeToken).toBe(MODERATO_FEE_TOKEN)
    expect(client.transport.url).toBe(MODERATO_RPC_URL)
    expect(moderatoClient('http://127.0.0.1:8545').transport.url).toBe('http://127.0.0.1:8545')
  })

  it('describes a USD token on it with the 6 decimals of every USD token on Tempo', () => {
    const token = '0x20c0000000000000000000000000000000000abc'
    expect(moderatoUsdToken(token)).toEqual({
      rail: 'tempo',
      chainId: TEMPO_MODERATO,
      token,
      currency: 'USD',
      decimals: 6,
    })
  })
})
