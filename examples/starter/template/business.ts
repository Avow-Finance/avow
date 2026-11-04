import type { SandboxBusinessConfig } from '@avow-finance/sdk'

// Your business. npm start signs your agent's mandate from this file, and asks you first. It opens
// your business's key only for that signature, once you type the key's passphrase.
export default {
  name: 'Starter Test Co',
  // The authority: the most your agent can hold in bookings at once. Avow refuses a booking past it.
  authority: 500,
  // The suppliers your agent can book with, and no others. Avow runs this one on Tempo's testnet.
  suppliers: [{ id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }],
} satisfies SandboxBusinessConfig
