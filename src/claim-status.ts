import type { ClaimVote, ResearchClaim } from "./ledger.js";

export const SCREENING_LENS = "screening";
export const REFUTATIONS_REQUIRED = 2;
export const MIN_VOTES_TO_SETTLE = 2;

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

export function markContestedByConflict(claim: ResearchClaim): boolean {
  if (claim.votes.length > 0) return false;
  if (claim.status !== "quoted" && claim.status !== "unverified") return false;
  claim.status = "contested";
  return true;
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
