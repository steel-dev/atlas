import type { AtlasJob } from "./do/atlas-job";

export interface Env {
  ATLAS_JOB: DurableObjectNamespace<AtlasJob>;
  ARTIFACTS: R2Bucket;

  ATLAS_API_KEY?: string;
  STEEL_API_KEY?: string;
  ANTHROPIC_API_KEY: string;

  STEEL_BASE_URL?: string;
}

export type AppVariables = { request_id: string };
export type AppEnv = { Bindings: Env; Variables: AppVariables };
