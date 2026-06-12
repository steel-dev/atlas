export const ECONOMY = {
  grantFloorUSD: 0.02,
  defaultGrantFraction: 0.15,
  researchSpawnFraction: 0.15,
  verifyReserve: { minUSD: 0.05 },
  verifySpawn: { fraction: 0.08, minUSD: 0.03 },
  verifySweep: { fraction: 0.08, minUSD: 0.03, maxClaims: 64, concurrency: 4 },
  eagerVerifyMaxClaims: 16,
  panelMinRemainingUSD: 0.04,
  synthesis: { fraction: 0.15, minUSD: 0.05 },
  conflicts: { fraction: 0.15, minUSD: 0.02 },
  adjudication: { remainingFraction: 0.1, minRemainingUSD: 0.15 },
  callReserve: { promptCharsPerToken: 4, assumedOutputTokens: 2_000 },
} as const;
