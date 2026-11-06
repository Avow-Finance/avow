import type { JobTool } from '@avow-finance/spec'

/**
 * The seven tools the session gives a model, as every provider's tool calling describes them, and
 * the form each one's input has to take. The descriptions are code-written and say what each tool
 * does and what checks it outside the model. Nothing here starts work, verifies the customer,
 * delivers, pays, signs a mandate, opens a key, edits a file or runs a command.
 */

/** One tool as a provider's tool calling takes it, with its parameters as JSON Schema. */
export interface ToolSpec {
  name: JobTool
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: false
  }
}

/** The parameters of a tool that takes none. */
const none = (): ToolSpec['parameters'] => ({
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
})

/**
 * The tools, as the model sees them. While the compute switch in `service.ts` is off,
 * `submit_quote` takes no booking, and its description says so.
 */
export function toolSpecs(computeSwitch: 'on' | 'off'): ToolSpec[] {
  return [
    {
      name: 'read_order',
      description:
        "The order Avow's test customer sent: the work, the GPUs it runs on, when it starts and is due, its price, and what the customer requires of the compute booking a quote names before it accepts.",
      parameters: none(),
    },
    {
      name: 'compute_offers',
      description:
        "avow-demo-gpu's offers of compute for the order's window. Each has its GPUs, how many one booking takes, its window, its price per GPU-hour, its reserve per GPU, and whether it was firm when listed or can still be cancelled at no charge. It also gives the limits that apply now: the compute budget and the compute switch in service.ts, and your authority.",
      parameters: none(),
    },
    {
      name: 'book_compute',
      description:
        "Books a number of GPUs of one offer, by the offer's id. service.ts checks its compute budget and compute switch first. Then the SDK checks your mandate, Avow approves the reserve, the reserve is funded in your business's own lock, and the supplier accepts. A refusal names the layer that refused and its reason code, and no money moves.",
      parameters: {
        type: 'object',
        properties: {
          offer: { type: 'string', description: 'The id of the offer, as compute_offers lists it' },
          quantity: { type: 'integer', minimum: 1, description: 'How many GPUs to book' },
        },
        required: ['offer', 'quantity'],
        additionalProperties: false,
      },
    },
    {
      name: 'cancel_compute',
      description:
        "Asks your business to cancel one of its compute bookings, by the booking's id. Your developer sees what's being cancelled and types the business's passphrase, since only the business's key can cancel on the lock. Before free cancellation ends it costs nothing, and after it the booking's terms decide what it costs.",
      parameters: {
        type: 'object',
        properties: {
          booking: {
            type: 'string',
            description: 'The id of the booking, as book_compute gave it',
          },
        },
        required: ['booking'],
        additionalProperties: false,
      },
    },
    computeSwitch === 'on'
      ? {
          name: 'submit_quote',
          description:
            "Quotes the order to the customer with terms that name one of your compute bookings, signed with your business's supplier signing key. The customer then checks the booking before it commits, and its answer comes after your turn.",
          parameters: {
            type: 'object',
            properties: {
              booking: {
                type: 'string',
                description:
                  'The id of the compute booking the quote names, as book_compute gave it',
              },
            },
            required: ['booking'],
            additionalProperties: false,
          },
        }
      : {
          name: 'submit_quote',
          description:
            "Quotes the order to the customer, signed with your business's supplier signing key. The compute switch in service.ts is off, so the quote names no compute booking. The customer checks it before it commits, and its answer comes after your turn.",
          parameters: none(),
        },
    {
      name: 'authority',
      description:
        'What your agent can commit now: the most for one commitment, the most it can hold at once and what is left of that, and what its key can still move today.',
      parameters: none(),
    },
    {
      name: 'commitments',
      description:
        "Every commitment your business's agent made in this session, with its role, amount, state on its lock and a link anyone can open to check it.",
      parameters: none(),
    },
  ]
}

/** A tool call's input once it's read, or why it couldn't be. */
export type ToolInput =
  | { tool: 'read_order' | 'compute_offers' | 'authority' | 'commitments' }
  | { tool: 'book_compute'; offer: string; quantity: number }
  | { tool: 'cancel_compute'; booking: string }
  | { tool: 'submit_quote'; booking: string | null }

const TOOLS: readonly JobTool[] = [
  'read_order',
  'compute_offers',
  'book_compute',
  'cancel_compute',
  'submit_quote',
  'authority',
  'commitments',
]

/** Whether a name is one of the seven tools. */
export const isJobTool = (name: string): name is JobTool =>
  (TOOLS as readonly string[]).includes(name)

/** An id the model passes, such as an offer's or a booking's, trimmed, or null when it isn't one. */
function idOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null
}

/** A whole count of GPUs from 1 to 1024. Models sometimes send a count as text, so that reads too. */
function countOf(value: unknown): number | null {
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1024 ? n : null
}

/**
 * Reads a model's input for a tool into a typed value, or null when it doesn't take that form. A
 * model's input is untrusted, so nothing reads it any other way.
 */
export function readToolInput(tool: JobTool, input: unknown): ToolInput | null {
  const value = (input ?? {}) as Record<string, unknown>
  if (typeof value !== 'object' || Array.isArray(value)) return null
  switch (tool) {
    case 'book_compute': {
      const offer = idOf(value.offer)
      const quantity = countOf(value.quantity)
      return offer && quantity ? { tool, offer, quantity } : null
    }
    case 'cancel_compute': {
      const booking = idOf(value.booking)
      return booking ? { tool, booking } : null
    }
    case 'submit_quote': {
      if (value.booking === undefined || value.booking === null || value.booking === '') {
        return { tool, booking: null }
      }
      const booking = idOf(value.booking)
      return booking ? { tool, booking } : null
    }
    default:
      return { tool }
  }
}
