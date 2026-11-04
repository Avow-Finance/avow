/** The agent's side of the SDK as Node loads it, keeping to the `.avow` folder and the runner's session. */
import { nodePlatform } from './node/platform.js'
import { setSandboxPlatform } from './sandbox/agent.js'

setSandboxPlatform(nodePlatform)

export * from './agent-entry.js'
