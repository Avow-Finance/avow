import type { SandboxBusinessConfig } from '@avow-finance/sdk'

// Your business. npm start signs your agent's mandate from this file, and asks you first. It opens
// your business's key only for that signature, once you type the key's passphrase.
export default {
  name: 'Starter Test Co',
  // The most your agent can hold in bookings at once, $500 held at once. Avow refuses a booking past
  // it, and the lock checks each reserve against Avow's approval.
  authority: 500,
  // The most your agent's key can move in a day, $1,000 a day moved by the key. Your business sets it
  // on chain, and your account's keychain holds the key to it whatever Avow approves.
  dailyLimit: 1000,
  // The suppliers your agent can book with, and no others. Avow runs this one on Tempo's testnet.
  suppliers: [{ id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }],
} satisfies SandboxBusinessConfig
