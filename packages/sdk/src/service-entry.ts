/**
 * What a developer's `service.ts` imports: `defineService`, the verdicts `checkBeforeWork` returns,
 * and their types. It holds nothing that signs or moves money.
 */
export {
  type CommitmentCheck,
  defineService,
  dontStart,
  type ReservedJob,
  type Service,
  type ServiceChecks,
  type ServiceFile,
  start,
  type Verdict,
} from './session/service.js'
