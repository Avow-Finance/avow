import {
  agentKeyTerms,
  approveSupplierCall,
  createLockCall,
  FACTORY_ABI,
  httpSupplier,
  moderatoClient,
  RESERVE_ABI,
  RESERVE_SELECTOR,
  reserveCalls,
  sandbox,
  sandboxMandate,
  sandboxTerms,
  sendOwn,
  sendSponsored,
} from '@avow-finance/sdk'
import {
  type Approval,
  approvalDigest,
  approvalTypedData,
  dollars,
  lockTerms,
  MESSAGE_VERSIONS,
  mandateHash,
  newSalt,
  type Signed,
  termsHash,
} from '@avow-finance/spec'
import {
  type Address,
  ContractFunctionRevertedError,
  encodeFunctionData,
  type Hex,
  hexToBigInt,
  keccak256,
  toHex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  prepareTransactionRequest,
  signTransaction,
  simulateContract,
  waitForTransactionReceipt,
} from 'viem/actions'
import { Abis, Account, Actions, Addresses, Relay } from 'viem/tempo'
import { describe, expect, it } from 'vitest'

/**
 * What the chain holds on Moderato when an agent's key goes around the SDK and Avow. The business
 * account, its lock and its agent's key are made for the run the way `sandbox.agent` makes them,
 * with no registration, and a fee payer the faucet funds stands in for Avow's relay, so nothing
 * here asks Avow anything. Every key is made for the run and held only in memory. Runs when
 * AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every way the lock's `reserve` reverts, so a revert reads by name. */
const RESERVE_ERRORS = [
  'NotAccount',
  'TooLate',
  'Expired',
  'WrongSide',
  'WrongToken',
  'CommitmentExists',
  'NonceUsed',
  'BadSignature',
  'SupplierNotApproved',
  'AboveCapPerCommitment',
  'AboveCapOpenReserves',
  'WrongFundingKey',
].map((name) => ({ type: 'error', name, inputs: [] }) as const)

describe.skipIf(!live)('the chain, around the SDK and Avow', () => {
  it(
    "reverts a reserve Avow never approved, and holds the agent's key to its daily limit",
    async () => {
      const deployment = await sandbox.deployment()
      const client = moderatoClient(deployment.rpcUrl)
      const root = Account.fromSecp256k1(generatePrivateKey())
      const agent = Account.fromSecp256k1(generatePrivateKey(), { access: root.address })
      await Actions.faucet.fundSync(client, { account: root.address, timeout: 60_000 })
      const lock: Address = await client.readContract({
        address: deployment.factory,
        abi: FACTORY_ABI,
        functionName: 'lockAddress',
        args: [root.address],
      })
      await sendOwn({
        client,
        account: root,
        calls: [createLockCall(deployment.factory, root.address)],
      })

      // The agent's key goes on the account under a sandbox mandate with $500 of authority, which
      // sets its daily spending limit to $500, and the root key approves the demo supplier.
      const supplier = (await httpSupplier(deployment.supplierUrl)).profile
      const now = BigInt(Math.floor(Date.now() / 1000))
      const limit = dollars(500)
      const mandate = sandboxMandate({
        businessId: 'chain-check',
        agentId: 'agt_chain_check',
        account: root.address,
        agentKey: agent.accessKeyAddress,
        suppliers: [supplier.businessId],
        token: deployment.token,
        capPerCommitment: limit,
        capOpenReserves: limit,
        expiry: now + 3600n,
      })
      const d = { chainId: deployment.chainId, verifyingContract: lock }
      const keyAuthorization = await Account.signKeyAuthorization(root, {
        key: agent,
        chainId: BigInt(deployment.chainId),
        ...agentKeyTerms(mandate, d, { lock, lockSelectors: [RESERVE_SELECTOR] }),
      })
      await sendOwn({
        client,
        account: root,
        calls: [approveSupplierCall(lock, supplier.account)],
        keyAuthorization,
      })
      const payer = privateKeyToAccount(generatePrivateKey())
      await Actions.faucet.fundSync(client, { account: payer.address, timeout: 60_000 })
      const relay = Relay.create({ client, plugins: [Relay.feePayer({ account: payer })] })
      const sponsor = (transaction: Hex) =>
        relay.request(
          { method: 'eth_signRawTransaction', params: [transaction] },
          { chainId: deployment.chainId },
        ) as Promise<Hex>

      // 1. The agent's key sends `reserve` straight to the lock, with an approval Avow never signed.
      const terms = sandboxTerms({
        deployment,
        resource: { gpu: 'H100', count: 8, hours: 1 },
        reserve: dollars(1),
        now,
      })
      const approval: Approval = {
        commitmentId: toHex(crypto.getRandomValues(new Uint8Array(32))),
        token: deployment.token,
        supplier: supplier.account,
        supplierSigner: supplier.signingKey,
        payee: supplier.payee,
        ...lockTerms(terms, 6),
        termsHash: termsHash(terms, newSalt()),
        mandateHash: mandateHash(mandate, d),
        capPerCommitment: mandate.capPerCommitment,
        capOpenReserves: mandate.capOpenReserves,
        fundingKey: agent.accessKeyAddress,
        nonce: hexToBigInt(toHex(crypto.getRandomValues(new Uint8Array(16)))),
        expiry: now + 120n,
      }
      const forger = privateKeyToAccount(generatePrivateKey())
      const forged: Signed<Approval> = {
        type: 'Approval',
        schemaVersion: MESSAGE_VERSIONS.Approval,
        chainId: deployment.chainId,
        lock,
        message: approval,
        signature: await forger.sign({ hash: approvalDigest(approval, d) }),
      }
      const reserve = reserveCalls(forged, d)[1] as { to: Address; data: Hex }
      const revertName = (blockNumber?: bigint) =>
        simulateContract(client, {
          account: root.address,
          address: lock,
          abi: [...RESERVE_ABI, ...RESERVE_ERRORS],
          functionName: 'reserve',
          args: [approvalTypedData(approval, d).message, forged.signature],
          ...(blockNumber === undefined ? {} : { blockNumber }),
        } as never).then(
          () => 'no revert',
          (error: Error & { walk: (f: (e: unknown) => boolean) => unknown }) => {
            const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as
              | ContractFunctionRevertedError
              | undefined
            return reverted?.data?.errorName ?? reverted?.signature ?? error.message
          },
        )
      expect(await revertName()).toBe('BadSignature')
      // Sent for real, with its gas set so the node takes it, it lands and reverts for anyone to see.
      const request = await prepareTransactionRequest(client, {
        account: agent,
        calls: [reserve],
        feePayer: true,
        nonceKey: 'expiring',
        gas: 800_000n,
      } as never)
      const bytes = await sponsor(
        await signTransaction(client, { ...request, account: agent } as never),
      )
      const hash = keccak256(bytes)
      // The public RPC can answer with an error after a transaction lands, so the hash decides.
      await client
        .request({ method: 'eth_sendRawTransaction', params: [bytes] })
        .catch(() => sleep(2000))
      const receipt = await waitForTransactionReceipt(client, { hash, timeout: 90_000 })
      expect(receipt.status).toBe('reverted')
      expect(await revertName(receipt.blockNumber)).toBe('BadSignature')

      // 2. The agent's key lets the lock pull at most its daily limit, whatever Avow signs.
      const remaining = async () =>
        (
          await client.readContract({
            address: Addresses.accountKeychain,
            abi: Abis.accountKeychain,
            functionName: 'getRemainingLimitWithPeriod',
            args: [root.address, agent.accessKeyAddress, deployment.token],
          })
        )[0]
      const approve = (amount: bigint) => ({
        to: deployment.token,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'approve',
          args: [lock, amount],
        }),
      })
      const send = (amount: bigint) =>
        sendSponsored({ client, account: agent, calls: [approve(amount)], sponsor })
      expect(await remaining()).toBe(limit)
      await expect(send(limit + 1n)).rejects.toThrow(/SpendingLimitExceeded/)
      expect(await remaining()).toBe(limit)
      expect((await send(limit)).status).toBe('success')
      expect(await remaining()).toBe(0n)
      // With the day's limit spent, even one more micro is refused.
      expect((await send(0n)).status).toBe('success')
      await expect(send(1n)).rejects.toThrow(/SpendingLimitExceeded/)
    },
    10 * 60_000,
  )
})
