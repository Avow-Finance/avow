// A Node consumer of `@avow-finance/sdk/slices`, which the package resolves by its own name. It
// has to see the socket calls the Node side adds as well as the calls both sides share.
import {
  createParentSigner,
  handOutSlice,
  serveWorkers,
  WorkerRefused,
  workerSigner,
  workerSocketPath,
} from '@avow-finance/sdk/slices'

export const calls = [
  createParentSigner,
  handOutSlice,
  serveWorkers,
  WorkerRefused,
  workerSigner,
  workerSocketPath,
]
