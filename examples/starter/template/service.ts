import { defineService, dontStart, start } from '@avow-finance/sdk/service'

/**
 * Your job service. Your agent reads none of this and can't change it. The session reads it again
 * before each turn, so an edit takes effect without a restart.
 */
export default defineService({
  // The most a compute booking may cost, in dollars per GPU-hour. The tool layer refuses an offer
  // over it before anything is booked.
  computeBudgetPerGpuHour: 3,

  // THE COMPUTE SWITCH. true books compute for each job and names it in the quote. Set it to false
  // and the agent quotes without compute, which Avow's test customer refuses.
  bookCompute: true,

  // Runs once the customer has reserved for a job, in a process of its own with no keys. Your
  // business accepts the job, and work starts, only when this returns start.
  async checkBeforeWork(job, avow) {
    const check = await avow.verifyCommitment(job)
    return check.ok ? start(check) : dontStart(check)
  },
})
