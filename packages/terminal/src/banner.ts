import { BANNER, BANNER_WIDTH } from './banner-art.js'
import { type Look, stylesOf, wrap } from './look.js'

/**
 * The environment setting create-avow-agent sets when it runs setup in the folder it made, having
 * drawn the banner and opened the rail, so setup carries the rail on. It changes only what's drawn.
 */
export const RAIL_OPEN_ENV = 'AVOW_SANDBOX_CONTINUE'

/** What every tool here says under its banner, as the sandbox's pages say at their top. */
export const TESTNET_LINE = 'Testnet sandbox. Test dollars only.'

/**
 * The banner a tool opens with. It draws Avow's mark and wordmark where the terminal is wide
 * enough for them and the word alone where it isn't, in the terminal's own ink as the site sets
 * the logo, with the testnet line under it.
 */
export function banner(look: Look): string {
  const s = stylesOf(look)
  const art =
    look.width >= BANNER_WIDTH + 4 ? BANNER.map((line) => `  ${line}`) : [`  ${s.bold('avow')}`]
  return ['', ...art, '', `  ${s.dim(TESTNET_LINE)}`, ''].join('\n')
}

/** What a first run is for, said once under the banner before anything is asked. */
export const FIRST_RUN_LINES = [
  'You want your AI agent to buy and sell for you, and nobody can trust it with money yet.',
  "In about two minutes, you give it limits it can't break and watch it win a paid job.",
] as const

/** The first run's lines, laid to the terminal's width under the banner. */
export function firstRunIntro(look: Look): string {
  const room = Math.max(1, look.width - 4)
  return [...FIRST_RUN_LINES.flatMap((line) => wrap(line, room).map((l) => `  ${l}`)), ''].join(
    '\n',
  )
}
