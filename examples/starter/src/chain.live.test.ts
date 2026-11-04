import {
  ADMINISTRATOR_ABI,
  agentKeyTerms,
  approveSupplierCall,
  authorizeSandboxKey,
  createLockCall,
  FACTORY_ABI,
  httpSupplier,
  liveKeys,
  lockCreatedIn,
  memoryStore,
  moderatoClient,
  RESERVE_ABI,
  RESERVE_SELECTOR,
  reserveCalls,
  revokeOtherKeys,
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
  BaseError,
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

  it(
    'revokes the old key when the authority goes down, and the old key can sign nothing',
    async () => {
      const deployment = await sandbox.deployment()
      const client = moderatoClient(deployment.rpcUrl)
      const root = Account.fromSecp256k1(generatePrivateKey())
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
      const demo = (await httpSupplier(deployment.supplierUrl)).profile
      // A second supplier the first mandate allows and the second drops.
      const other = {
        ...demo,
        businessId: 'other-supplier',
        account: privateKeyToAccount(generatePrivateKey()).address,
      }
      const now = BigInt(Math.floor(Date.now() / 1000))
      const authorize = async (authority: number, suppliers: (typeof demo)[], revoke?: Address) => {
        const key = Account.fromSecp256k1(generatePrivateKey(), { access: root.address })
        const mandate = sandboxMandate({
          businessId: 'chain-check',
          agentId: `agt_${key.accessKeyAddress.slice(2, 12).toLowerCase()}`,
          account: root.address,
          agentKey: key.accessKeyAddress,
          suppliers: suppliers.map((s) => s.businessId),
          token: deployment.token,
          capPerCommitment: dollars(authority),
          capOpenReserves: dollars(authority),
          expiry: now + 3600n,
        })
        await authorizeSandboxKey({
          deployment,
          client,
          root,
          agent: key,
          lock,
          mandate,
          suppliers,
          ...(revoke ? { revoke, remove: [other.account] } : {}),
        })
        return key
      }
      const approved = (supplier: Address) =>
        client.readContract({
          address: lock,
          abi: ADMINISTRATOR_ABI,
          functionName: 'approvedSupplier',
          args: [supplier],
        })
      const old = await authorize(500, [demo, other])
      expect(await approved(other.account)).toBe(true)
      // The authority goes down to $100 with the demo supplier only, in one transaction from the root
      // key, which revokes the old key and takes the dropped supplier off the lock.
      const next = await authorize(100, [demo], old.accessKeyAddress)
      const keyOf = (key: Address) =>
        client.readContract({
          address: Addresses.accountKeychain,
          abi: Abis.accountKeychain,
          functionName: 'getKey',
          args: [root.address, key],
        })
      expect((await keyOf(old.accessKeyAddress)).isRevoked).toBe(true)
      expect((await keyOf(next.accessKeyAddress)).isRevoked).toBe(false)
      expect(await approved(other.account)).toBe(false)
      expect(await approved(demo.account)).toBe(true)

      const payer = privateKeyToAccount(generatePrivateKey())
      await Actions.faucet.fundSync(client, { account: payer.address, timeout: 60_000 })
      const relay = Relay.create({ client, plugins: [Relay.feePayer({ account: payer })] })
      const sponsor = (transaction: Hex) =>
        relay.request(
          { method: 'eth_signRawTransaction', params: [transaction] },
          { chainId: deployment.chainId },
        ) as Promise<Hex>
      const approve = {
        to: deployment.token,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'approve',
          args: [lock, dollars(1)],
        }),
      }
      // The old key tries what its old permissions allowed, signed and sent straight to the node.
      let hash: Hex | null = null
      const refused = await (async () => {
        const request = await prepareTransactionRequest(client, {
          account: old,
          calls: [approve],
          feePayer: true,
          nonceKey: 'expiring',
          gas: 300_000n,
        } as never)
        const bytes = await sponsor(
          await signTransaction(client, { ...request, account: old } as never),
        )
        hash = keccak256(bytes)
        await client.request({ method: 'eth_sendRawTransaction', params: [bytes] })
        return 'accepted'
      })().catch((error: unknown) =>
        error instanceof BaseError ? `${error.shortMessage} ${error.details}` : String(error),
      )
      expect(refused).toMatch(/access key is not authorized/i)
      if (hash) expect(await client.getTransaction({ hash }).catch(() => null)).toBeNull()
      // The new key works within its own permissions, and has none of the business's authority.
      expect(
        (await sendSponsored({ client, account: next, calls: [approve], sponsor })).status,
      ).toBe('success')
      const revokeItself = {
        to: Addresses.accountKeychain as Address,
        data: encodeFunctionData({
          abi: Abis.accountKeychain,
          functionName: 'revokeKey',
          args: [next.accessKeyAddress],
        }),
      }
      await expect(
        sendSponsored({ client, account: next, calls: [revokeItself], sponsor }),
      ).rejects.toThrow(/CallNotAllowed/)
      await expect(
        sendSponsored({
          client,
          account: next,
          calls: [approveSupplierCall(lock, other.account)],
          sponsor,
        }),
      ).rejects.toThrow(/CallNotAllowed/)
    },
    10 * 60_000,
  )

  it(
    'revokes every key the keychain still authorizes, admin keys too, from where the chain says the lock began',
    async () => {
      const deployment = await sandbox.deployment()
      const client = moderatoClient(deployment.rpcUrl)
      const root = Account.fromSecp256k1(generatePrivateKey())
      await Actions.faucet.fundSync(client, { account: root.address, timeout: 60_000 })
      const lock: Address = await client.readContract({
        address: deployment.factory,
        abi: FACTORY_ABI,
        functionName: 'lockAddress',
        args: [root.address],
      })
      const created = await sendOwn({
        client,
        account: root,
        calls: [createLockCall(deployment.factory, root.address)],
      })
      const demo = (await httpSupplier(deployment.supplierUrl)).profile
      const now = BigInt(Math.floor(Date.now() / 1000))
      const authorize = async () => {
        const key = Account.fromSecp256k1(generatePrivateKey(), { access: root.address })
        await authorizeSandboxKey({
          deployment,
          client,
          root,
          agent: key,
          lock,
          mandate: sandboxMandate({
            businessId: 'chain-check',
            agentId: `agt_${key.accessKeyAddress.slice(2, 12).toLowerCase()}`,
            account: root.address,
            agentKey: key.accessKeyAddress,
            suppliers: [demo.businessId],
            token: deployment.token,
            capPerCommitment: dollars(500),
            capOpenReserves: dollars(500),
            expiry: now + 3600n,
          }),
          suppliers: [demo],
        })
        return key.accessKeyAddress.toLowerCase()
      }
      const first = await authorize()
      const second = await authorize()
      // An admin key signs for the account at the lock as the root key does.
      const admin = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
      await sendOwn({
        client,
        account: root,
        calls: [
          {
            to: Addresses.accountKeychain,
            data: encodeFunctionData({
              abi: Abis.accountKeychain,
              functionName: 'authorizeAdminKey',
              args: [admin as Address, 0, keccak256(toHex('chain-check'))],
            }),
          },
        ],
      })
      // The agent rewrites every file it can reach. The start of the scan comes from the factory's
      // event on chain, so the keys authorized before any of that are still found.
      const store = memoryStore()
      await store.write('business', JSON.stringify({ business: null }))
      await store.write('agent', '')
      const since = await lockCreatedIn({
        client,
        factory: deployment.factory,
        account: root.address,
        lock,
      })
      expect(since).toBe(created.blockNumber)
      const live = await liveKeys(client, root.address, since)
      expect(live.map((k) => k.toLowerCase()).sort()).toEqual([first, second, admin].sort())
      expect((await revokeOtherKeys({ client, root, since })).length).toBe(3)
      expect(await liveKeys(client, root.address, since)).toEqual([])
      for (const key of [first, second, admin]) {
        const k = await client.readContract({
          address: Addresses.accountKeychain,
          abi: Abis.accountKeychain,
          functionName: 'getKey',
          args: [root.address, key as Address],
        })
        expect(k.isRevoked).toBe(true)
      }
      expect(
        await client.readContract({
          address: Addresses.accountKeychain,
          abi: Abis.accountKeychain,
          functionName: 'isAdminKey',
          args: [root.address, admin as Address],
        }),
      ).toBe(false)
    },
    10 * 60_000,
  )
})
