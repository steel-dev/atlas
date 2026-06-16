import type {
  ClaimSourceQuality,
  ClaimVote,
  ResearchClaim,
} from "./ledger.js";
import { NEUTRAL_RECENCY, recencyScore } from "./recency.js";

export const SCREENING_LENS = "screening";
export const REFUTATIONS_REQUIRED = 2;
export const MIN_VOTES_TO_SETTLE = 2;

export const QUALITY_RANK: Record<ClaimSourceQuality, number> = {
  primary: 0,
  secondary: 1,
  blog: 2,
  forum: 3,
  unreliable: 4,
};

const CORROBORATION_STRENGTH_CAP = 2;
const RECENCY_STRENGTH_SWING = 0.75;

export function evidenceStrength(
  claim: ResearchClaim,
  todayISO?: string,
): number {
  const base =
    4 -
    QUALITY_RANK[claim.sourceQuality] +
    Math.min(
      Math.max((claim.corroboration ?? 1) - 1, 0),
      CORROBORATION_STRENGTH_CAP,
    );
  if (!todayISO) return base;
  return (
    base +
    (recencyScore(claim.publishedTime, todayISO) - NEUTRAL_RECENCY) *
      (RECENCY_STRENGTH_SWING / NEUTRAL_RECENCY)
  );
}

export function settleClaim(claim: ResearchClaim, votes: ClaimVote[]): void {
  claim.votes = votes;
  const refutedVotes = votes.filter((vote) => vote.refuted).length;
  const screeningOnly =
    votes.length > 0 && votes.every((vote) => vote.lens === SCREENING_LENS);
  if (screeningOnly && refutedVotes === 0) {
    claim.status = "screened";
  } else if (votes.length < MIN_VOTES_TO_SETTLE) {
    claim.status = claim.conflictsWith?.length ? "contested" : "unverified";
  } else if (refutedVotes >= REFUTATIONS_REQUIRED) {
    claim.status = "refuted";
  } else if (refutedVotes > 0) {
    claim.status = "contested";
  } else {
    claim.status = "confirmed";
  }
}

export function adoptVerdictsOnMerge(
  representative: ResearchClaim,
  duplicate: ResearchClaim,
): void {
  if (representative.votes.length === 0 && duplicate.votes.length > 0) {
    representative.votes = duplicate.votes;
    representative.status = duplicate.status;
  }
}

export function voteSplit(claim: ResearchClaim): string {
  const refuted = claim.votes.filter((vote) => vote.refuted).length;
  return `${claim.votes.length - refuted}-${refuted}`;
}
