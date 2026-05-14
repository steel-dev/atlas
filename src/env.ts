import type { AtlasJob } from "./do/atlas-job";

export interface Env {
  ATLAS_JOB: DurableObjectNamespace<AtlasJob>;
  ARTIFACTS: R2Bucket;

  STEEL_API_KEY: string;
  ANTHROPIC_API_KEY: string;

  STEEL_BASE_URL?: string;
}
