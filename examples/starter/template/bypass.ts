/**
 * Tries to get past your agent's limits without Avow.
 *
 * This file imports nothing of Avow's. It signs four transactions with your agent's own key and
 * sends them straight to Tempo's public node, the way an agent that ignored the SDK could. A
 * throwaway account, funded by the testnet faucet, pays the fees, so Avow's relay takes no part
 * either. The first transaction is one the key allows, which shows the key works. The other three
 * are ones your mandate forbids. Each is sent with a fixed gas limit, so it lands in a block and
 * you can open its revert in the explorer.
 *
 * Run it with `npm run bypass` once `npm start` has set your agent up. The allowed transaction
 * leaves your lock approved for $1, which counts against today's limit and moves no money.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type Address,
  createClient,
  encodeFunctionData,
  type Hex,
  http,
  isAddress,
  publicActions,
  walletActions,
} from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account, Actions, Addresses, tempoActions } from 'viem/tempo'

const RPC = 'https://rpc.moderato.tempo.xyz'
const EXPLORER = tempoModerato.blockExplorers.default.url
/** AlphaUSD, which pays Moderato's fees and comes from its faucet. */
const FEE_TOKEN: Address = '0x20C0000000000000000000000000000000000001'
/** Enough for any one call here. A fixed limit skips the node's estimate, which a revert fails. */
const GAS = 400_000n
const DOLLAR = 1_000_000n

const usd = (micros: bigint) =>
  `$${(Number(micros) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2 })}`

/** What the script needs of your agent: its key, and your business's account, token and lock. */
export interface AgentOnChain {
  key: Hex
  account: Address
  token: Address
  lock: Address
}

/** Reads `.avow/agent.json`, which `npm start` writes once your business signs the mandate. */
export function readAgent(json: string | null): AgentOnChain {
  if (json === null) throw new Error('Your agent has no key yet. Run npm start first.')
  const item = JSON.parse(json) as {
    agentKey?: unknown
    business?: { account?: unknown; token?: unknown; lock?: unknown }
  }
  const { account, token, lock } = item.business ?? {}
  const key = item.agentKey
  const address = (v: unknown): v is Address => typeof v === 'string' && isAddress(v)
  if (
    typeof key !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(key) ||
    !address(account) ||
    !address(token) ||
    !address(lock)
  ) {
    throw new Error("agent.json doesn't hold an agent's key and its business. Run npm start again.")
  }
  return { key: key as Hex, account, token, lock }
}

/** One transaction the script sent, and what the chain did with it. */
export interface Attempt {
  title: string
  /** Whether your mandate allows it. */
  allowed: boolean
  /** Landed and took effect, landed and reverted, or refused by the node before any block. */
  outcome: 'landed' | 'reverted' | 'refused'
  /** The chain's own name for why, such as CallNotAllowed. */
  reason: string | null
  /** The transaction in the explorer, when it reached a block. */
  link: string | null
}

/** The chain's reason inside a viem error, which nests the node's message under its own. */
function reasonOf(error: unknown): string {
  let last = ''
  for (
    let e = error as { message?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as never
  ) {
    last = (e.message ?? '').split('\n')[0] ?? last
    const named = /keychain error: (\w+)/.exec(e.message ?? '')
    if (named?.[1]) return named[1]
  }
  return last.slice(0, 120) || 'no reason given'
}

/**
 * Sends the four transactions and says what happened to each. It returns every attempt with your
 * business's balance before and after, so a caller can check that nothing moved.
 */
export async function tryToBypass(
  agentJson: string | null,
  say: (line: string) => void = console.log,
): Promise<{ attempts: Attempt[]; before: bigint; after: bigint }> {
  const { key, account, token, lock } = readAgent(agentJson)
  const chain = tempoModerato.extend({ feeToken: FEE_TOKEN })
  const transport = http(RPC, { retryCount: 6, retryDelay: 500 })
  const node = createClient({ chain, transport }).extend(publicActions).extend(tempoActions())
  // Your agent's key, signing for your business's account as the account's keychain lets it.
  const agent = Account.fromSecp256k1(key, { access: account })
  const signer = createClient({ account: agent, chain, transport }).extend(walletActions)

  say("Signing with your agent's own key. Avow's SDK, API and relay take no part in this.")
  say('A throwaway account pays the fees, funded by the testnet faucet.')
  const payer = Account.fromSecp256k1(generatePrivateKey())
  await Actions.faucet.fundSync(node, { account: payer.address, timeout: 60_000 })
  const stranger = Account.fromSecp256k1(generatePrivateKey()).address

  const balance = () =>
    node.readContract({
      address: token,
      abi: Abis.tip20,
      functionName: 'balanceOf',
      args: [account],
    })
  const tokenCall = (functionName: 'approve' | 'transfer', to: Address, amount: bigint) => ({
    to: token,
    data: encodeFunctionData({ abi: Abis.tip20, functionName, args: [to, amount] }),
  })

  const attempts: Attempt[] = []
  async function attempt(title: string, allowed: boolean, call: { to: Address; data: Hex }) {
    // Preparing the transaction has the node run it, which gives the chain's reason for a revert.
    let reason = await signer
      .prepareTransactionRequest({ calls: [call], feePayer: payer } as never)
      .then(() => null, reasonOf)
    let outcome: Attempt['outcome']
    let link: string | null = null
    try {
      const hash = await signer.sendTransaction({
        calls: [call],
        feePayer: payer,
        gas: GAS,
      } as never)
      const receipt = await node.waitForTransactionReceipt({ hash, timeout: 60_000 })
      outcome = receipt.status === 'success' ? 'landed' : 'reverted'
      link = `${EXPLORER}/tx/${hash}`
    } catch (error) {
      outcome = 'refused'
      reason ??= reasonOf(error)
    }
    attempts.push({ title, allowed, outcome, reason, link })
    say('')
    say(`${outcome === 'landed' ? '✓' : '✗'} ${title}`)
    const what =
      outcome === 'landed'
        ? 'landed'
        : outcome === 'reverted'
          ? `reverted by the chain, ${reason ?? 'with no reason given'}`
          : `refused by the node, ${reason}`
    say(`  ${what}${link ? `\n  ${link}` : ''}`)
  }

  const before = await balance()
  await attempt(
    `Approve your lock for ${usd(DOLLAR)}, which the key allows`,
    true,
    tokenCall('approve', lock, DOLLAR),
  )
  await attempt(
    `Send ${usd(DOLLAR)} of your business's money to a stranger`,
    false,
    tokenCall('transfer', stranger, DOLLAR),
  )
  await attempt(
    `Let a stranger pull ${usd(DOLLAR)} from your business`,
    false,
    tokenCall('approve', stranger, DOLLAR),
  )
  // The keychain counts each rise in an approval against the day's limit. So the last attempt
  // raises the lock's approval by a dollar more than the key has left today, both read from the
  // chain after the first call.
  const [left] = await node.readContract({
    address: Addresses.accountKeychain,
    abi: Abis.accountKeychain,
    functionName: 'getRemainingLimitWithPeriod',
    args: [account, agent.accessKeyAddress, token],
  })
  const approved = await node.readContract({
    address: token,
    abi: Abis.tip20,
    functionName: 'allowance',
    args: [account, lock],
  })
  await attempt(
    `Raise your lock's approval by ${usd(left + DOLLAR)}, ${usd(DOLLAR)} more than today's limit has left`,
    false,
    tokenCall('approve', lock, approved + left + DOLLAR),
  )
  const after = await balance()

  say('')
  say(`Your business held ${usd(before)} before and holds ${usd(after)} now.`)
  const slipped = attempts.filter((a) => !a.allowed && a.outcome === 'landed')
  if (slipped.length > 0) {
    say(
      `${slipped.length} forbidden transaction${slipped.length === 1 ? '' : 's'} landed. Tell Avow, since that should never happen.`,
    )
  } else {
    say("Tempo's keychain holds your agent's key to its mandate, whatever code signs with it.")
    say(
      "The cap on what your agent holds at once is Avow's to check, and your lock takes no reserve without Avow's approval.",
    )
  }
  return { attempts, before, after }
}

// Runs when this file is the one started, as `npm run bypass` starts it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let agentJson: string | null = null
  try {
    agentJson = readFileSync(join(process.cwd(), '.avow', 'agent.json'), 'utf8')
  } catch {}
  try {
    const { attempts, before, after } = await tryToBypass(agentJson)
    const held = attempts.every((a) =>
      a.allowed ? a.outcome === 'landed' : a.outcome !== 'landed',
    )
    process.exitCode = held && before === after ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
