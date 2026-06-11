export const ECONOMY = {
  grantFloorUSD: 0.02,
  defaultGrantFraction: 0.15,
  researchSpawnFraction: 0.15,
  verifyReserve: { fraction: 0.2, minUSD: 0.05 },
  verifySpawn: { fraction: 0.08, minUSD: 0.03 },
  verifySweep: { fraction: 0.08, minUSD: 0.03, maxClaims: 64, concurrency: 4 },
  eagerVerifyMaxClaims: 16,
  panelMinRemainingUSD: 0.04,
  synthesis: { fraction: 0.15, minUSD: 0.05 },
  dedupe: { fraction: 0.15, minUSD: 0.02 },
  callReserve: { promptCharsPerToken: 4, assumedOutputTokens: 2_000 },
} as const;
