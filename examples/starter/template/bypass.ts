/**
 * Tries to get past your agent's limits without Avow.
 *
 * This file imports nothing of Avow's. It signs five transactions with your agent's own key and
 * sends them straight to Tempo's public node, the way an agent that ignored the SDK could. A
 * throwaway account, funded by the testnet faucet, pays the fees, so Avow's relay takes no part
 * either. The first transaction is one the key allows, which shows the key works. The next three
 * are ones your mandate forbids, which Tempo's keychain reverts. The last asks your lock for a
 * reserve under an approval your agent wrote for itself, with a limit of its own choosing, which
 * the lock reverts since Avow's key didn't sign it. Each is sent with a fixed gas limit, so it
 * lands in a block and you can open its revert in the explorer.
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
  decodeErrorResult,
  encodeFunctionData,
  type Hex,
  http,
  isAddress,
  keccak256,
  parseAbi,
  publicActions,
  stringToHex,
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

/**
 * Your lock's `reserve`, which takes a reserve only under an approval Avow's key signed. The
 * approval carries the limits Avow checked your mandate for, and the lock enforces those.
 */
const LOCK_ABI = parseAbi([
  'struct Charge { uint8 kind; uint256 most; uint64 earliest; }',
  'struct Approval { bytes32 commitmentId; uint8 side; address token; uint256 amount; address supplier; address supplierSigner; address payee; uint64 freeCancelBy; uint64 acceptBy; uint64 chargeDeadline; uint64 releaseDate; uint64 contestWindow; Charge[] charges; uint16 day90SupplierShareBps; address arbiter; bytes32 termsHash; bytes32 mandateHash; uint256 capPerCommitment; uint256 capOpenReserves; address fundingKey; uint256 nonce; uint64 expiry; }',
  'function reserve(Approval a, bytes avowSignature)',
  ...[
    'NotAccount',
    'TooLate',
    'Expired',
    'WrongSide',
    'WrongToken',
    'CommitmentExists',
    'NonceUsed',
    'BadSignature',
    'TimesOutOfOrder',
    'ContestWindowShort',
    'BadShare',
    'BadCharges',
    'BadAddress',
    'BadArbiter',
    'BadAmount',
    'SupplierNotApproved',
    'AboveCapPerCommitment',
    'AboveCapOpenReserves',
    'WrongFundingKey',
  ].map((name) => `error ${name}()` as const),
])

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
 * Sends the five transactions and says what happened to each. It returns every attempt with your
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

  /** The lock's own name for why it reverts a call from your business's account, when it does. */
  async function lockReason(call: { to: Address; data: Hex }): Promise<string | null> {
    try {
      await node.call({ account, ...call })
      return null
    } catch (error) {
      for (
        let e = error as { data?: unknown; cause?: unknown } | undefined;
        e;
        e = e.cause as never
      ) {
        if (typeof e.data !== 'string' || !/^0x[0-9a-f]{8}/i.test(e.data)) continue
        try {
          return decodeErrorResult({ abi: LOCK_ABI, data: e.data as Hex }).errorName
        } catch {}
      }
      return null
    }
  }

  const attempts: Attempt[] = []
  async function attempt(title: string, allowed: boolean, call: { to: Address; data: Hex }) {
    // Preparing the transaction has the node run it, which gives the chain's reason for a revert.
    // A call to your lock is run again for the lock's own error, which the node doesn't name.
    let reason = await signer
      .prepareTransactionRequest({ calls: [call], feePayer: payer } as never)
      .then(() => null, reasonOf)
    if (reason && call.to === lock) reason = (await lockReason(call)) ?? reason
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
  // The last attempt goes to your lock. Your agent writes its own approval for a reserve of $501,
  // with limits of a million dollars, and signs it with its own key where Avow's belongs.
  const now = (await node.getBlock()).timestamp
  const label = (text: string) => keccak256(stringToHex(text))
  const own = {
    commitmentId: label(`a reserve nobody approved, at ${now}`),
    side: 0,
    token,
    amount: 501n * DOLLAR,
    supplier: stranger,
    supplierSigner: stranger,
    payee: stranger,
    freeCancelBy: now + 600n,
    acceptBy: now + 900n,
    chargeDeadline: now + 1800n,
    releaseDate: now + 1800n,
    contestWindow: 600n,
    charges: [{ kind: 0, most: DOLLAR, earliest: now + 600n }],
    day90SupplierShareBps: 5000,
    arbiter: payer.address,
    termsHash: label('terms nobody agreed'),
    mandateHash: label('a mandate nobody signed'),
    capPerCommitment: 1_000_000n * DOLLAR,
    capOpenReserves: 1_000_000n * DOLLAR,
    fundingKey: agent.accessKeyAddress,
    nonce: now,
    expiry: now + 900n,
  } as const
  const ownSignature = await agent.sign({ hash: label('an approval the agent wrote for itself') })
  await attempt(
    `Reserve ${usd(own.amount)} in your lock under an approval your agent wrote for itself`,
    false,
    {
      to: lock,
      data: encodeFunctionData({
        abi: LOCK_ABI,
        functionName: 'reserve',
        args: [own, ownSignature],
      }),
    },
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
      "Your lock takes a reserve only under an approval Avow's key signed, and enforces the limits that approval carries.",
    )
    say(
      'Avow checks those limits against your mandate before it signs, so that check is the one you rely on Avow for.',
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
