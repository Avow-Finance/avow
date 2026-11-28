import { describe, expect, it } from 'vitest'
import { readArgs } from './args.js'
import { ChatError, openAiCompatible, readCompletion } from './chat.js'

const KEY = 'sk-test-made-for-this-test'

function endpoint(...answers: { status: number; body: unknown }[]) {
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    })
    const next = answers.shift() ?? { status: 500, body: {} }
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status,
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, sent }
}

const completion = {
  model: 'anthropic/claude-sonnet-5.5-20261101',
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'book', arguments: '{"reserve":200}' },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 1200, completion_tokens: 30, cost: 0.0042 },
}

describe('an OpenAI-compatible model', () => {
  it('sends the conversation and the tools with the key in the header only, and reads the calls back', async () => {
    const { fetch, sent } = endpoint({ status: 200, body: completion })
    const model = openAiCompatible({
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: KEY,
      model: 'anthropic/claude-sonnet-5.5',
      fetch,
    })
    const reply = await model.complete(
      [{ role: 'user', content: 'Book $200.' }],
      [{ name: 'book', description: 'Books', parameters: { type: 'object' } }],
    )
    expect(reply).toEqual({
      content: '',
      calls: [{ id: 'call_a', name: 'book', arguments: '{"reserve":200}' }],
      usage: { promptTokens: 1200, completionTokens: 30, cost: 0.0042 },
      served: 'anthropic/claude-sonnet-5.5-20261101',
    })
    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent[0]?.body).toEqual({
      model: 'anthropic/claude-sonnet-5.5',
      messages: [{ role: 'user', content: 'Book $200.' }],
      tools: [
        {
          type: 'function',
          function: { name: 'book', description: 'Books', parameters: { type: 'object' } },
        },
      ],
      temperature: 0,
      usage: { include: true },
    })
    expect(JSON.stringify(sent[0]?.body)).not.toContain(KEY)
  })

  it('asks for the cost only from OpenRouter, since another endpoint may refuse the field', async () => {
    const { fetch, sent } = endpoint({ status: 200, body: completion })
    await openAiCompatible({
      baseUrl: 'https://api.example.com/v1',
      apiKey: KEY,
      model: 'm',
      fetch,
    }).complete([], [])
    expect(sent[0]?.body).toEqual({ model: 'm', messages: [], temperature: 0 })
  })

  it('tries again after a rate limit or a server error, and gives up on anything else', async () => {
    const busy = endpoint(
      { status: 429, body: 'slow down' },
      { status: 502, body: '' },
      { status: 200, body: completion },
    )
    const model = openAiCompatible({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: KEY,
      model: 'm',
      fetch: busy.fetch,
      backoff: () => 0,
    })
    expect((await model.complete([], [])).calls).toHaveLength(1)
    expect(busy.sent).toHaveLength(3)

    const missing = endpoint({ status: 404, body: { error: { message: 'No such model' } } })
    const lost = openAiCompatible({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: KEY,
      model: 'm',
      fetch: missing.fetch,
      backoff: () => 0,
    })
    await expect(lost.complete([], [])).rejects.toThrow(/answered 404.*No such model/)
    expect(missing.sent).toHaveLength(1)
  })

  it('never surfaces the key, even when the endpoint echoes it back', async () => {
    const { fetch } = endpoint({ status: 401, body: `invalid key ${KEY}` })
    const model = openAiCompatible({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: KEY,
      model: 'm',
      fetch,
    })
    const error = await model.complete([], []).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ChatError)
    expect((error as Error).message).toBe('The endpoint answered 401: invalid key [key]')
  })

  it('reads an error OpenRouter sends with a 200, and arguments a provider sent as an object', () => {
    expect(() =>
      readCompletion(JSON.stringify({ error: { code: 502, message: 'Provider down' } })),
    ).toThrow('The endpoint answered with an error: Provider down')
    const reply = readCompletion(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'Hi',
              tool_calls: [{ function: { name: 'status', arguments: {} } }],
            },
          },
        ],
      }),
    )
    expect(reply).toEqual({
      content: 'Hi',
      calls: [{ id: 'call_1', name: 'status', arguments: '{}' }],
      usage: null,
      served: null,
    })
  })
})

describe('the run flags', () => {
  it('read the models, the endpoint, the variable that holds the key and the folder', () => {
    expect(readArgs(['--model', 'a/b, c/d', '--model', 'e/f', '--out', 'here'])).toEqual({
      models: ['a/b', 'c/d', 'e/f'],
      baseUrl: 'https://openrouter.ai/api/v1',
      keyEnv: 'OPENROUTER_API_KEY',
      out: 'here',
      trials: 3,
    })
    expect(readArgs(['--model', 'm', '--trials', '5'])).toMatchObject({ trials: 5 })
    expect(readArgs(['--model', 'm', '--trials', '0'])).toEqual({
      error: '--trials is a whole number from 1 to 10',
    })
    expect(
      readArgs([
        '--model',
        'm',
        '--key-env',
        'OTHER_KEY',
        '--base-url',
        'https://api.example.com/v1',
      ]),
    ).toMatchObject({
      keyEnv: 'OTHER_KEY',
      baseUrl: 'https://api.example.com/v1',
    })
  })

  it('refuse a run with no model, an endpoint without https or a key given in place of its variable', () => {
    expect(readArgs([])).toEqual({ error: 'Name at least one model with --model' })
    expect(readArgs(['--model', 'm', '--base-url', 'http://localhost:1'])).toEqual({
      error: '--base-url has to be https',
    })
    expect(readArgs(['--model', 'm', '--key-env', 'sk-or-v1-abc'])).toEqual({
      error: '--key-env names a variable, such as OPENROUTER_API_KEY',
    })
    expect(readArgs(['--model'])).toEqual({ error: '--model needs a value' })
  })
})
