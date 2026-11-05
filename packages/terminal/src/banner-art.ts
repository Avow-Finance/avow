/**
 * Avow's mark and wordmark in block characters, traced from the logo at three sub-pixels to each
 * hundred units of the mark's 750 by 475 drawing, so its squares land on whole cells. Each cell is
 * a quadrant block, two sub-pixels wide and two tall.
 */
export const BANNER: readonly string[] = [
  '        ▄███▘███',
  '       ▟██▛  ███             ▗▄▄▄▖ ▄▄    ▄▖ ▗▄▄▄  ▄▖  ▗▄▖  ▗▄',
  '     ▗███▘   ███   ▄▄▄      ▐█▀▀▀█▙▝█▌  ▟█▘▟█▀▀▀█▙▜█▖ ▟█▙  █▛',
  '    ▟██▛▘    ███   ███      ▗▄▄█▛██ ▜█▖▐█▘▐█▌   ██ █▙▗█▘█▖▟█▘',
  '  ▗▟██▛   ███   ███         ██▖ ▄██  ▜▙█▛  █▙▄ ▄█▛ ▐██▌ ▐██▌',
  ' ▗███▘ ▄▄▄▀▀▀▄▄▄▀▀▀          ▀▀▀▘▝▀▘ ▝▀▀    ▝▀▀▀▘   ▀▀   ▀▀',
  '▟██▛   ███   ███',
]

/** The widest line of the banner, in columns. */
export const BANNER_WIDTH = Math.max(...BANNER.map((line) => line.length))
