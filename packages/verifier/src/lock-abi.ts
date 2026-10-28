/**
 * The views of the lock and of the demo factory that the Tempo reader calls, as the contracts
 * declare them. `commitment` returns the lock's stored record for one side of a commitment.
 */
export const LOCK_ABI = [
  {
    type: 'function',
    name: 'account',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'token',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'factory',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'minContestWindow',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'confirmWindow',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'rulingDelay',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'rulingKeyEnd',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'day90',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'commitment',
    inputs: [
      {
        name: 'commitmentId',
        type: 'bytes32',
      },
      {
        name: 'side',
        type: 'uint8',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'state',
            type: 'uint8',
          },
          {
            name: 'hasReport',
            type: 'bool',
          },
          {
            name: 'reportFinal',
            type: 'bool',
          },
          {
            name: 'confirmed',
            type: 'bool',
          },
          {
            name: 'contested',
            type: 'bool',
          },
          {
            name: 'hasRuling',
            type: 'bool',
          },
          {
            name: 'kinds',
            type: 'uint8',
          },
          {
            name: 'reportKind',
            type: 'uint8',
          },
          {
            name: 'reportCount',
            type: 'uint8',
          },
          {
            name: 'pausedBy',
            type: 'uint8',
          },
          {
            name: 'day90ShareBps',
            type: 'uint16',
          },
          {
            name: 'businessEvidence',
            type: 'uint16',
          },
          {
            name: 'supplierEvidence',
            type: 'uint16',
          },
          {
            name: 'freeCancelBy',
            type: 'uint64',
          },
          {
            name: 'acceptBy',
            type: 'uint64',
          },
          {
            name: 'chargeDeadline',
            type: 'uint64',
          },
          {
            name: 'releaseDate',
            type: 'uint64',
          },
          {
            name: 'contestWindow',
            type: 'uint64',
          },
          {
            name: 'reportDeadline',
            type: 'uint64',
          },
          {
            name: 'chargeStart',
            type: 'uint64',
          },
          {
            name: 'pausedAt',
            type: 'uint64',
          },
          {
            name: 'rulingPostedAt',
            type: 'uint64',
          },
          {
            name: 'reportedAt',
            type: 'uint64',
          },
          {
            name: 'amount',
            type: 'uint128',
          },
          {
            name: 'held',
            type: 'uint128',
          },
          {
            name: 'reportAmount',
            type: 'uint128',
          },
          {
            name: 'rulingToSupplier',
            type: 'uint128',
          },
          {
            name: 'supplier',
            type: 'address',
          },
          {
            name: 'supplierSigner',
            type: 'address',
          },
          {
            name: 'payout',
            type: 'address',
          },
          {
            name: 'arbiter',
            type: 'address',
          },
          {
            name: 'rulingByArbiter',
            type: 'bool',
          },
          {
            name: 'fundedBy',
            type: 'address',
          },
          {
            name: 'termsHash',
            type: 'bytes32',
          },
          {
            name: 'mandateHash',
            type: 'bytes32',
          },
          {
            name: 'approvalHash',
            type: 'bytes32',
          },
          {
            name: 'reportEvidence',
            type: 'bytes32',
          },
          {
            name: 'most',
            type: 'uint128[4]',
          },
          {
            name: 'earliest',
            type: 'uint64[4]',
          },
          {
            name: 'firstReportAt',
            type: 'uint64[4]',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const

export const FACTORY_ABI = [
  {
    type: 'function',
    name: 'isLock',
    inputs: [
      {
        name: 'lock',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
  },
] as const
