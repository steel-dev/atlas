export const ECONOMY = {
  grantFloorUSD: 0.02,
  defaultGrantFraction: 0.15,
  researchSpawnFraction: 0.15,
  verifyReserve: { minUSD: 0.05 },
  verify: {
    perClaimFraction: 0.08,
    concurrency: 4,
    sweepMaxClaims: 64,
    eagerMaxClaims: 16,
    eagerConcurrency: 3,
    eagerConcurrencyDuringResearch: 1,
  },
  synthesis: { fraction: 0.15, minUSD: 0.05 },
  conflicts: { fraction: 0.15, minUSD: 0.02 },
  checklist: { fraction: 0.04, minUSD: 0.03 },
  adjudication: {
    remainingFraction: 0.1,
    minRemainingUSD: 0.15,
    verifyHeadroomFraction: 0.3,
  },
  callReserve: { promptCharsPerToken: 4, assumedOutputTokens: 2_000 },
} as const;
