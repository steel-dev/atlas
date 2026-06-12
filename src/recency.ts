const YEAR_REGEX = /\b(?:19|20)\d{2}\b/;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

// Fresh up to this age, then linear decay to zero at FULL_DECAY_YEARS.
const FRESH_YEARS = 0.5;
const FULL_DECAY_YEARS = 6;

// Neutral score for sources with no parseable date — neither rewarded nor
// penalised, so an undated source ranks between a fresh and a stale one.
export const NEUTRAL_RECENCY = 0.5;

export function parsePublishedDate(
  publishedTime: string | undefined,
): number | undefined {
  if (!publishedTime) return undefined;
  const direct = Date.parse(publishedTime);
  if (!Number.isNaN(direct)) return direct;
  const year = YEAR_REGEX.exec(publishedTime);
  if (year) {
    const mid = Date.parse(`${year[0]}-07-01`);
    if (!Number.isNaN(mid)) return mid;
  }
  return undefined;
}

// 1 = fresh, 0 = fully stale, NEUTRAL_RECENCY = undateable. `todayISO` is the
// run's journaled anchor date (rctx.todayISO), so this stays deterministic
// across resume — never read the wall clock here.
export function recencyScore(
  publishedTime: string | undefined,
  todayISO: string,
): number {
  const published = parsePublishedDate(publishedTime);
  if (published === undefined) return NEUTRAL_RECENCY;
  const now = Date.parse(todayISO);
  if (Number.isNaN(now)) return NEUTRAL_RECENCY;
  const ageYears = Math.max(0, (now - published) / MS_PER_YEAR);
  if (ageYears <= FRESH_YEARS) return 1;
  if (ageYears >= FULL_DECAY_YEARS) return 0;
  return Math.max(
    0,
    1 - (ageYears - FRESH_YEARS) / (FULL_DECAY_YEARS - FRESH_YEARS),
  );
}

const TIME_SENSITIVE_REGEX =
  /\b(?:latest|newest|current|currently|recent|recently|nowadays|today|this year|up[- ]?to[- ]?date|state[- ]of[- ]the[- ]art|cutting[- ]edge|trend|trending|upcoming|20(?:2[4-9]|3\d))\b|최신|현재|지금|올해|요즘|최근|트렌드|동향/i;

// Whether the question is asking about a fast-moving / time-bound topic, in
// which case recency is weighted more heavily when ranking claims.
export function isTimeSensitive(question: string): boolean {
  return TIME_SENSITIVE_REGEX.test(question);
}
