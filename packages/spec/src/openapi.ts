import { z } from 'zod'
import {
  agentRequestJson,
  agentRequestStatusJson,
  openAgentRequestJson,
  openAgentRequestStatusJson,
} from './agent-connect.js'
import {
  API_PATHS,
  cancellationAnswerJson,
  contestStatementAnswerJson,
  contestStatementRequestJson,
  enrollmentJson,
  enrollmentRequestJson,
  reserveApprovalJson,
  reserveApprovalRequestJson,
  sponsorshipJson,
  startReceiptAnswerJson,
  startReceiptRequestJson,
  startRequestAnswerJson,
  supplierAuthorizationAnswerJson,
} from './api.js'
import { API_AUTH_SCHEME, API_REQUEST_MAX_VALIDITY } from './api-request.js'
import {
  mailboxAcceptedJson,
  mailboxOrderJson,
  mailboxOrderRequestJson,
  mailboxReservedJson,
} from './mailbox.js'
import { REASON_CODES } from './reasons.js'
import { SANDBOX_PATHS } from './sandbox.js'
import {
  businessRegistrationBody,
  sandboxRegistrationAnswerJson,
  supplierRegistrationBody,
} from './sandbox-registration.js'
import { supplierProfileJson } from './supplier-adapter.js'
import { jobRequirementJson, quoteRequestJson } from './test-customer.js'
import { jobTermsJson } from './wire.js'

/**
 * The OpenAPI document for Avow's testnet API, which the docs site's API reference and its API
 * Explorer are built from. Each body's schema is the zod schema its parser checks first, so the
 * reference can't describe a body the API reads differently. Signed messages inside a body are
 * objects the parser checks against their own schemas, named in their descriptions. Each path comes
 * from the path constants the SDK sends to.
 */

/** Where the testnet API runs, the audience every signed request names. */
export const TESTNET_API_URL = 'https://api.testnet.avow.finance'

/** A route's operation, before it's turned into OpenAPI. */
export interface ApiOperation {
  method: 'get' | 'post'
  path: string
  operationId: string
  tag: ApiTag
  summary: string
  description: string
  /** Who signs the request, or null for a route anyone may call unsigned. */
  signedBy: string | null
  /** The domain the request is signed under: the business's lock, or the factory before one exists. */
  domain?: 'lock' | 'factory'
  params?: readonly { name: string; description: string; example: string }[]
  request?: { schema: z.ZodType; example?: unknown }
  answer: { status: number; description: string; schema: z.ZodType; example?: unknown }
  /** Statuses the route refuses with, beside the ones every signed route can give. */
  refusals?: readonly number[]
}

export const API_TAGS = ['Status', 'Agents', 'Commitments', 'Suppliers', 'Mailbox'] as const
export type ApiTag = (typeof API_TAGS)[number]

const TAG_DESCRIPTIONS: { readonly [T in ApiTag]: string } = {
  Status: 'Whether the API is up and ready. Anyone may call these, unsigned.',
  Agents:
    'How an agent asks a business for authority, enrolls once approved, and gets its transactions sponsored.',
  Commitments:
    "Avow's approval of a reserve, and the records Avow keeps on a commitment: cancellations, start requests and receipts, and contest statements.",
  Suppliers:
    "Registering a business in the sandbox, registering a supplier's signing key, and reading a supplier's profile.",
  Mailbox:
    "The sandbox mailbox, which carries a job between two businesses' agents wherever each runs.",
}

// Path templates from the constants, with each parameter put back as an OpenAPI placeholder.
const ZERO_ID = `0x${'0'.repeat(64)}` as const
const ZERO_ORDER = '0'.repeat(32)
const onCommitment = (path: (id: `0x${string}`) => string) =>
  path(ZERO_ID).replace(ZERO_ID, '{commitmentId}')
const onOrder = (path: (id: string) => string) => path(ZERO_ORDER).replace(ZERO_ORDER, '{orderId}')
const SUPPLIER_PATH = SANDBOX_PATHS.supplier('BUSINESS').replace('BUSINESS', '{businessId}')

const COMMITMENT_ID = {
  name: 'commitmentId',
  description: 'The commitment id, 32 bytes in lower-case hex',
  example: `0x${'ab'.repeat(32)}`,
}
const ORDER_ID = {
  name: 'orderId',
  description: 'The order id the buyer chose, 16 bytes as 32 lower-case hex characters',
  example: '3f1c9a2b7d4e5f60718293a4b5c6d7e8',
}

const statusJson = (status: string) => z.strictObject({ status: z.literal(status) })

/** Every route the docs describe, in the order the reference lists them. */
export const API_OPERATIONS: readonly ApiOperation[] = [
  {
    method: 'get',
    path: '/v1/health',
    operationId: 'health',
    tag: 'Status',
    summary: 'Health',
    description: 'Answers while the API process runs.',
    signedBy: null,
    answer: {
      status: 200,
      description: 'The API is running',
      schema: statusJson('ok'),
      example: { status: 'ok' },
    },
  },
  {
    method: 'get',
    path: '/v1/ready',
    operationId: 'ready',
    tag: 'Status',
    summary: 'Ready',
    description: 'Answers once the API can reach its database and take requests.',
    signedBy: null,
    answer: {
      status: 200,
      description: 'The API is ready',
      schema: statusJson('ready'),
      example: { status: 'ready' },
    },
    refusals: [503],
  },
  {
    method: 'post',
    path: SANDBOX_PATHS.agentRequests,
    operationId: 'askBusiness',
    tag: 'Agents',
    summary: 'Ask a business for authority',
    description:
      "An agent asks a named business for authority, signed by the key it made, under that business's lock. It hears the answer by sending the same request again. The answer carries a pairing code the administrator checks in the console, and once approved, the body the agent enrolls with. The request grants nothing, since only the business account's root key approves.",
    signedBy: "The agent's key",
    domain: 'lock',
    request: {
      schema: agentRequestJson,
      example: {
        businessId: 'sandbox-9df2eec2a472a1819d20fba1f8a6f70a232f6447',
        label: 'Research agent',
      },
    },
    answer: {
      status: 200,
      description: 'Where the request stands: pending, approved or expired',
      schema: agentRequestStatusJson,
      example: {
        state: 'pending',
        businessId: 'sandbox-9df2eec2a472a1819d20fba1f8a6f70a232f6447',
        agentKey: '0x1b7a7c8f0e5d4c3b2a19087f6e5d4c3b2a190871',
        lock: '0x504e2d08432886e971fd6d961ddcc009e86b260b',
        label: 'Research agent',
        pairingCode: 'K7Q2-M9XD',
        requestedAt: '1763420400',
        expiresAt: '1763424000',
        signingKey: null,
      },
    },
  },
  {
    method: 'post',
    path: SANDBOX_PATHS.openAgentRequests,
    operationId: 'askAnyBusiness',
    tag: 'Agents',
    summary: 'Ask for authority without a business',
    description:
      'An agent asks before it knows its business, signed under the factory. Whoever approves through the link chooses their business, and the approval binds the request to the business whose root key signed the mandate. Once the answer says bound, the agent asks that business as any agent does.',
    signedBy: "The agent's key",
    domain: 'factory',
    request: { schema: openAgentRequestJson, example: { label: 'Research agent' } },
    answer: {
      status: 200,
      description: 'Where the request stands: open, bound to a business, or expired',
      schema: openAgentRequestStatusJson,
    },
  },
  {
    method: 'post',
    path: API_PATHS.enrollments,
    operationId: 'enroll',
    tag: 'Agents',
    summary: 'Enroll an agent',
    description:
      'An agent enrolls once its key is on the business account, with the mandate the administrator approved. Avow checks the mandate against the account and the transaction that authorized the key.',
    signedBy: "The agent's key",
    domain: 'lock',
    request: { schema: enrollmentRequestJson },
    answer: {
      status: 200,
      description: 'The agent as Avow enrolled it',
      schema: enrollmentJson,
      example: {
        businessId: 'sandbox-9df2eec2a472a1819d20fba1f8a6f70a232f6447',
        agentId: 'agt_95c1d05c',
        agentKey: '0x1b7a7c8f0e5d4c3b2a19087f6e5d4c3b2a190871',
        mandateHash: `0x${'cd'.repeat(32)}`,
      },
    },
  },
  {
    method: 'post',
    path: API_PATHS.sponsorships,
    operationId: 'sponsor',
    tag: 'Agents',
    summary: 'Sponsor a transaction',
    description:
      "Avow's relay co-signs a transaction the agent signed with feePayer set, so Avow pays the network fee, or refuses with the cap, rate limit or budget it hit. The relay pays fees only and never moves money into a reserve.",
    signedBy: "The agent's key",
    domain: 'lock',
    request: { schema: sponsorshipJson, example: { transaction: '0x76f8a5' } },
    answer: {
      status: 200,
      description: 'The transaction with the relay as fee payer',
      schema: sponsorshipJson,
      example: { transaction: '0x76f8a5' },
    },
  },
  {
    method: 'post',
    path: API_PATHS.reserveApprovals,
    operationId: 'approveReserve',
    tag: 'Commitments',
    summary: 'Approve a reserve',
    description:
      "An agent asks Avow to approve a reserve for terms it agreed with a supplier. Avow checks the mandate, the business's open reserves and any bookings the terms rely on, and answers with a signed approval the lock checks, or a refusal with its reason code. Avow records its decision either way.",
    signedBy: "The agent's key",
    domain: 'lock',
    request: { schema: reserveApprovalRequestJson },
    answer: {
      status: 200,
      description: "Avow's decision, approved with its signed approval or refused with a reason",
      schema: reserveApprovalJson,
      example: { ok: false, decisionId: 'dec_7f3a91', reason: 'mandate.over_open_reserves_cap' },
    },
  },
  {
    method: 'post',
    path: onCommitment(API_PATHS.supplierAuthorizations),
    operationId: 'authorizeSupplier',
    tag: 'Commitments',
    summary: 'Authorize a supplier',
    description:
      "A supplier asks for a fresh authorization for a commitment's reserve. With it come the approval the reserve was funded under and the buyer's mandate, which the supplier's verifier checks against its own terms and the lock before it accepts.",
    signedBy: "The supplier's signing key",
    domain: 'lock',
    params: [COMMITMENT_ID],
    answer: {
      status: 200,
      description: 'The authorization, approval and mandate, or a refusal with a reason',
      schema: supplierAuthorizationAnswerJson,
      example: { ok: false, reason: 'commitment.unknown' },
    },
  },
  {
    method: 'post',
    path: onCommitment(API_PATHS.cancellations),
    operationId: 'cancel',
    tag: 'Commitments',
    summary: 'Record a late cancellation',
    description:
      'A business cancels after free cancellation has ended, and Avow records when, with its signed timestamp. A late-cancellation charge rests on this record. Before free cancellation ends the business cancels on the lock instead.',
    signedBy: 'The key of the agent that made the commitment',
    domain: 'lock',
    params: [COMMITMENT_ID],
    answer: {
      status: 200,
      description: 'When Avow received the cancellation, and its timestamp',
      schema: cancellationAnswerJson,
    },
  },
  {
    method: 'post',
    path: onCommitment(API_PATHS.startRequests),
    operationId: 'requestStart',
    tag: 'Commitments',
    summary: 'Ask to start',
    description:
      "A business asks the supplier to start the job, and Avow timestamps the request. The supplier's start receipt names it, and the job can't have started before it.",
    signedBy: 'The key of the agent that made the commitment',
    domain: 'lock',
    params: [COMMITMENT_ID],
    answer: {
      status: 200,
      description: "The request's digest and Avow's timestamp on it",
      schema: startRequestAnswerJson,
    },
  },
  {
    method: 'post',
    path: onCommitment(API_PATHS.startReceipts),
    operationId: 'recordStartReceipt',
    tag: 'Commitments',
    summary: 'Record a start receipt',
    description: "The business's agent passes on the supplier's start receipt for Avow to record.",
    signedBy: 'The key of the agent that made the commitment',
    domain: 'lock',
    params: [COMMITMENT_ID],
    request: { schema: startReceiptRequestJson },
    answer: {
      status: 200,
      description: 'Recorded, or refused with a reason',
      schema: startReceiptAnswerJson,
      example: { ok: true },
    },
  },
  {
    method: 'post',
    path: onCommitment(API_PATHS.contestStatements),
    operationId: 'recordContestStatement',
    tag: 'Commitments',
    summary: 'Record a contest statement',
    description:
      "The business sends the statement for a contest the lock already took, so Avow holds the text it rules on. Avow records it only when the named transaction holds the lock's Paused event with the statement's reason code and hash.",
    signedBy: "The business account's root key",
    domain: 'lock',
    params: [COMMITMENT_ID],
    request: { schema: contestStatementRequestJson },
    answer: {
      status: 200,
      description: "The statement's hash and when Avow first recorded it",
      schema: contestStatementAnswerJson,
      example: { statementHash: `0x${'ef'.repeat(32)}`, recordedAt: '1763420400' },
    },
  },
  {
    method: 'post',
    path: SANDBOX_PATHS.businesses,
    operationId: 'registerBusiness',
    tag: 'Suppliers',
    summary: 'Register a sandbox business',
    description:
      "A business registers in the sandbox with a registration its account's root key signed, and Avow pays it test dollars. A sandbox business isn't verified.",
    signedBy: "The business account's root key",
    domain: 'lock',
    request: { schema: businessRegistrationBody },
    answer: {
      status: 200,
      description: "The business's id and the test dollars Avow paid it",
      schema: sandboxRegistrationAnswerJson,
      example: {
        businessId: 'sandbox-9df2eec2a472a1819d20fba1f8a6f70a232f6447',
        testData: true,
        payout: { transactionHash: `0x${'12'.repeat(32)}`, amount: '1500000000' },
      },
    },
  },
  {
    method: 'post',
    path: SANDBOX_PATHS.suppliers,
    operationId: 'registerSupplier',
    tag: 'Suppliers',
    summary: 'Register a supplier',
    description:
      'A business registers as a supplier, naming its payee and the signing key that quotes and accepts for it. The account and the signing key both sign the registration.',
    signedBy: "The business account's root key, or the signing key it registers",
    domain: 'factory',
    request: { schema: supplierRegistrationBody },
    answer: {
      status: 200,
      description: "The supplier's profile as Avow registered it",
      schema: supplierProfileJson,
    },
  },
  {
    method: 'get',
    path: SUPPLIER_PATH,
    operationId: 'supplierProfile',
    tag: 'Suppliers',
    summary: "Read a supplier's profile",
    description:
      "The account, payee and signing key Avow registered for a sandbox supplier. Anyone may read it, unsigned, and a buyer's verifier checks a quote's signature against the signing key.",
    signedBy: null,
    params: [
      {
        name: 'businessId',
        description: "The supplier's business id",
        example: 'sandbox-9df2eec2a472a1819d20fba1f8a6f70a232f6447',
      },
    ],
    answer: {
      status: 200,
      description: "The supplier's profile",
      schema: supplierProfileJson,
      example: {
        businessId: 'sandbox-9df2eec2a472a1819d20fba1f8a6f70a232f6447',
        account: '0x9df2eec2a472a1819d20fba1f8a6f70a232f6447',
        payee: '0x9df2eec2a472a1819d20fba1f8a6f70a232f6447',
        signingKey: '0x07504744d00b218539cfe7739f00b980ecd64d35',
      },
    },
    refusals: [404],
  },
  {
    method: 'post',
    path: SANDBOX_PATHS.mailboxOrders,
    operationId: 'sendOrder',
    tag: 'Mailbox',
    summary: 'Send an order',
    description:
      "A buyer's agent orders a job from another business, with an expiry. Nothing is reserved until the buyer funds the quote.",
    signedBy: "The buyer agent's key",
    domain: 'lock',
    request: { schema: mailboxOrderRequestJson },
    answer: {
      status: 200,
      description: 'The order as the mailbox holds it',
      schema: mailboxOrderJson,
    },
  },
  {
    method: 'post',
    path: SANDBOX_PATHS.mailboxInbox,
    operationId: 'readInbox',
    tag: 'Mailbox',
    summary: 'Read the inbox',
    description: "A supplier's agent reads the orders waiting on its business, oldest first.",
    signedBy: "The supplier's signing key",
    domain: 'lock',
    answer: {
      status: 200,
      description: 'Up to twenty orders',
      schema: z.strictObject({ orders: z.array(mailboxOrderJson) }),
    },
  },
  {
    method: 'post',
    path: onOrder(SANDBOX_PATHS.mailboxOrder),
    operationId: 'readOrder',
    tag: 'Mailbox',
    summary: 'Read an order',
    description: 'Either side reads one order and where it stands.',
    signedBy: "Either side's key",
    domain: 'lock',
    params: [ORDER_ID],
    answer: { status: 200, description: 'The order', schema: mailboxOrderJson },
  },
  {
    method: 'post',
    path: onOrder(SANDBOX_PATHS.mailboxQuote),
    operationId: 'sendQuote',
    tag: 'Mailbox',
    summary: 'Send a quote',
    description: "The supplier's agent answers an order with terms it signed.",
    signedBy: "The supplier's signing key",
    domain: 'lock',
    params: [ORDER_ID],
    answer: { status: 200, description: 'The order, now quoted', schema: mailboxOrderJson },
  },
  {
    method: 'post',
    path: onOrder(SANDBOX_PATHS.mailboxReserved),
    operationId: 'sayReserved',
    tag: 'Mailbox',
    summary: 'Say the reserve landed',
    description:
      "The buyer's agent says its reserve is on the lock. Avow reads the lock itself, so the transaction is optional.",
    signedBy: "The buyer agent's key",
    domain: 'lock',
    params: [ORDER_ID],
    request: { schema: mailboxReservedJson, example: { fundedIn: null } },
    answer: { status: 200, description: 'The order, now reserved', schema: mailboxOrderJson },
  },
  {
    method: 'post',
    path: onOrder(SANDBOX_PATHS.mailboxAccepted),
    operationId: 'sayAccepted',
    tag: 'Mailbox',
    summary: 'Say the acceptance landed',
    description:
      "The supplier's agent says the lock shows its acceptance. Avow reads the lock itself, so the transaction is optional.",
    signedBy: "The supplier's signing key",
    domain: 'lock',
    params: [ORDER_ID],
    request: { schema: mailboxAcceptedJson, example: { acceptedIn: null } },
    answer: { status: 200, description: 'The order, now accepted', schema: mailboxOrderJson },
  },
]

/** Schemas several bodies share, which the document defines once and refers to by name. */
const SHARED: readonly (readonly [string, z.ZodType])[] = [
  ['JobTerms', jobTermsJson],
  ['JobRequirement', jobRequirementJson],
  ['QuoteRequest', quoteRequestJson],
  ['MailboxOrder', mailboxOrderJson],
  ['SupplierProfile', supplierProfileJson],
]

/**
 * Every body's schema as the JSON Schema OpenAPI 3.1 takes, describing what a caller sends or
 * reads. Each operation's bodies are named after it, and a shared schema inside them becomes a
 * reference to its one definition.
 */
function bodySchemas(): { refs: Map<z.ZodType, string>; schemas: Record<string, unknown> } {
  const registry = z.registry<{ id: string }>()
  const refs = new Map<z.ZodType, string>()
  const name = (schema: z.ZodType, id: string) => {
    if (refs.has(schema)) return
    refs.set(schema, id)
    registry.add(schema, { id })
  }
  for (const [id, schema] of SHARED) name(schema, id)
  for (const op of API_OPERATIONS) {
    const title = `${op.operationId.charAt(0).toUpperCase()}${op.operationId.slice(1)}`
    if (op.request) name(op.request.schema, `${title}Request`)
    name(op.answer.schema, `${title}Answer`)
  }
  const out = z.toJSONSchema(registry, {
    io: 'input',
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Record<string, unknown>> }
  const schemas: Record<string, unknown> = {}
  for (const [id, schema] of Object.entries(out.schemas)) {
    const { $schema: _, id: _id, ...rest } = schema
    schemas[id] = rest
  }
  return { refs, schemas }
}

const SIGNING = `Every route but the status routes and a supplier's profile is signed. The request carries an \`Authorization\` header of the form \`${API_AUTH_SCHEME} signer=<address>, lock=<address>, requestId=<bytes32>, expiry=<unix seconds>, signature=<hex>\`. The signature is EIP-712 over an \`ApiRequest\` naming this API's origin as its audience, the method, the path, the request id, the expiry and the body's hash, under the domain of the business's lock, or of the factory where a route says so. A request stays valid for at most ${API_REQUEST_MAX_VALIDITY} seconds, and a request id is used once. The SDK signs every request, so a caller rarely builds this header by hand, and the API Explorer can send only the unsigned routes.`

/** The OpenAPI document for the testnet API. */
export function openApiDocument(): Record<string, unknown> {
  const { refs, schemas } = bodySchemas()
  const ref = (schema: z.ZodType) => ({ $ref: `#/components/schemas/${refs.get(schema)}` })
  const paths: Record<string, Record<string, unknown>> = {}
  for (const op of API_OPERATIONS) {
    const responses: Record<string, unknown> = {
      [op.answer.status]: {
        description: op.answer.description,
        content: {
          'application/json': {
            schema: ref(op.answer.schema),
            ...(op.answer.example === undefined ? {} : { example: op.answer.example }),
          },
        },
      },
    }
    const refusals = [...(op.signedBy ? [400, 401, 409] : []), ...(op.refusals ?? []), 503]
    for (const status of [...new Set(refusals)].sort()) {
      responses[status] = { $ref: `#/components/responses/Refusal${status}` }
    }
    const signer = op.signedBy
      ? `\n\nSigned by ${op.signedBy.charAt(0).toLowerCase()}${op.signedBy.slice(1)}, under the ${op.domain === 'factory' ? "factory's" : "business lock's"} domain.`
      : ''
    paths[op.path] = {
      ...paths[op.path],
      [op.method]: {
        operationId: op.operationId,
        tags: [op.tag],
        summary: op.summary,
        description: `${op.description}${signer}`,
        security: op.signedBy ? [{ AvowSignature: [] }] : [],
        ...(op.params
          ? {
              parameters: op.params.map((p) => ({
                name: p.name,
                in: 'path',
                required: true,
                description: p.description,
                schema: { type: 'string' },
                example: p.example,
              })),
            }
          : {}),
        ...(op.request
          ? {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: ref(op.request.schema),
                    ...(op.request.example === undefined ? {} : { example: op.request.example }),
                  },
                },
              },
            }
          : {}),
        responses,
      },
    }
  }
  const refusal = (description: string) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Refusal' } } },
  })
  return {
    openapi: '3.1.0',
    info: {
      title: "Avow's testnet API",
      version: '1',
      description: `The API Avow's SDK, verifier and console talk to, on Tempo's Moderato testnet with test dollars. Bodies are JSON, with amounts and times as decimal strings.\n\n${SIGNING}`,
    },
    servers: [{ url: TESTNET_API_URL, description: 'Moderato testnet' }],
    tags: API_TAGS.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    paths,
    components: {
      securitySchemes: {
        AvowSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: SIGNING,
        },
      },
      schemas: {
        ...schemas,
        Refusal: {
          type: 'object',
          required: ['error'],
          description:
            "A refusal, with its reason code and a sentence. Avow's relay adds the fields its codes name, such as retryAt.",
          properties: {
            error: {
              type: 'object',
              required: ['reason', 'message'],
              properties: {
                reason: { type: 'string', enum: Object.keys(REASON_CODES) },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        Refusal400: refusal('The request or its body is malformed'),
        Refusal401: refusal('The request is unsigned, its signature is wrong, or it expired'),
        Refusal404: refusal('Avow has no such record'),
        Refusal409: refusal('The request id was used before, or the same request is in progress'),
        Refusal503: refusal('The API is unavailable for now, so try again'),
      },
    },
  }
}
