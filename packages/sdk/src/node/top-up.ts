import { formatUsd } from '@avow-finance/spec'
import { agentTopUp } from '../sandbox/agent.js'
import { fileStore } from './platform.js'

/**
 * `avow-sandbox top-up`: the agent in this folder asks the sandbox faucet for more test dollars for
 * its business, with its own key. They go to the business's account, never its lock, so no limit
 * changes, and a business gets one a day.
 */
export async function topUpCommand(): Promise<void> {
  const t = await agentTopUp({ store: fileStore() })
  const next = new Date(Number(t.nextAt) * 1000).toISOString()
  if (t.state === 'not_yet') {
    console.log(
      `Your business had its top-up for today, so nothing was sent. Ask again at ${next}.`,
    )
    return
  }
  console.log(
    `The sandbox faucet is sending your business ${formatUsd(BigInt(t.amount))} in test dollars, to its account and not its lock, so your agent's limits are the same.`,
  )
  console.log(`Transfer: ${t.transactionHash}`)
  console.log(`Your business can top up again at ${next}.`)
}
