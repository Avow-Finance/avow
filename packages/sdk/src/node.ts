/**
 * The SDK as Node loads it. It's the same SDK, with the sandbox keeping its keys in the working
 * directory's `.avow` folder and reporting to the session its runner opened.
 */
import { nodePlatform } from './node/platform.js'
import { setSandboxPlatform } from './sandbox/agent.js'

setSandboxPlatform(nodePlatform)

export * from './index.js'
