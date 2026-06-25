export const ECONOMY = {
  grantFloorUSD: 0.02,
  defaultGrantFraction: 0.15,
  synthesis: { fraction: 0.15, minUSD: 0.05 },
  callReserve: { promptCharsPerToken: 4, assumedOutputTokens: 2_000 },
} as const;
