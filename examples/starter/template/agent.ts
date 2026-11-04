import { Refusal, sandbox } from '@avow-finance/sdk'

// The supplier: Avow's demo GPU supplier, which runs on Tempo's Moderato testnet.
const supplier = { id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }

// The authority: your agent can hold up to $500 in bookings at once, with that supplier only.
// Change it, and the next run signs and enrolls a new mandate.
const agent = await sandbox.agent({ authority: 500, suppliers: [supplier] })

try {
  // The booking: 8 H100s for an hour, backed by a $200 reserve in your business's own lock.
  const commitment = await agent.book({
    supplier: supplier.id,
    resource: { gpu: 'H100', count: 8, hours: 1 },
    reserve: 200,
  })
  console.log(`Committed $${commitment.amount}, with $${commitment.left} of authority left.`)
  console.log('Commitment reference:', commitment.reference)
  console.log(`Anyone can check it at ${commitment.link}`)

  // The open verifier, on your machine: what the supplier checks before it holds the GPUs.
  for (const check of await commitment.verify()) {
    console.log(`${check.passed ? 'Passed' : `Failed (${check.reason})`}: ${check.name}`)
  }

  // The supplier runs the same checks, then accepts on your lock.
  const accepted = await commitment.accepted()
  console.log(
    accepted
      ? 'The supplier checked the commitment and accepted it.'
      : "The supplier didn't accept in time, so the reserve goes back to your business.",
  )
} catch (error) {
  if (!(error instanceof Refusal)) throw error
  console.log(`Refused by ${error.layer}: ${error.code}`)
  console.log(error.message)
}
