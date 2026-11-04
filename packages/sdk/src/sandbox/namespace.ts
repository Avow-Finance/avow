import { sandboxAgent } from './agent.js'
import { loadSandboxDeployment } from './deployment.js'
import { prepareSandboxBusiness } from './setup.js'
import { memoryStore } from './store.js'

/**
 * Avow's sandbox on Tempo's Moderato testnet. `sandbox.business` is the business's side, which
 * holds the root key and signs the agent's mandate, and only the runner calls it. `sandbox.agent`
 * is the agent's side, which acts with only the agent's key.
 */
export const sandbox = {
  agent: sandboxAgent,
  business: prepareSandboxBusiness,
  deployment: loadSandboxDeployment,
  memoryStore,
} as const
