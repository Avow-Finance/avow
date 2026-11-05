import { BANNER, BANNER_WIDTH } from './banner-art.js'
import { type Look, stylesOf } from './look.js'

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
