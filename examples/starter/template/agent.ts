import { Refusal, sandbox } from '@avow-finance/sdk/agent'

// Your agent, under the mandate your business signed from business.ts. It holds only its own key,
// so nothing here can change what it's allowed to commit you to.
const agent = await sandbox.agent()

try {
  // The booking: 8 H100s for an hour from Avow's demo GPU supplier, backed by a $200 reserve.
  const commitment = await agent.book({
    supplier: 'avow-demo-gpu',
    resource: { gpu: 'H100', count: 8, hours: 1 },
    reserve: 200,
  })
  console.log(`Committed $${commitment.amount}, with $${commitment.left} of authority left.`)
  console.log('Commitment reference:', commitment.reference)
  console.log(`Anyone can check it at ${commitment.link}`)

  // The open verifier, on your machine: Avow's approval against your terms and mandate, then the lock.
  for (const check of await commitment.verify()) {
    console.log(`${check.passed ? 'Passed' : `Failed (${check.reason})`}: ${check.name}`)
  }

  // The supplier checks the commitment too, then accepts on your lock.
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
