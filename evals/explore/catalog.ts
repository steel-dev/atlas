import { readCases, DEFAULT_CASES_URL } from "../draco.js";
import type { Store } from "./store.js";

function revisionOf(casesUrl: string): string {
  const match = casesUrl.match(/resolve\/([^/]+)\//);
  return match ? match[1] : "live";
}

export async function ensureCatalog(
  store: Store,
  casesUrl: string = DEFAULT_CASES_URL,
  force = false,
): Promise<number> {
  const revision = revisionOf(casesUrl);
  if (!force && store.getMeta("catalog_revision") === revision) {
    return store.caseCount();
  }
  const cases = await readCases(casesUrl);
  for (const entry of cases) {
    store.upsertCase({
      caseId: entry.id,
      domain: entry.domain,
      problem: entry.problem,
      rubricId: entry.rubricId,
      criteriaCount: entry.criteria.length,
      sectionsJson: JSON.stringify(entry.sections),
      criteriaJson: JSON.stringify(entry.criteria),
      casesRevision: revision,
    });
  }
  store.setMeta("catalog_revision", revision);
  return cases.length;
}
