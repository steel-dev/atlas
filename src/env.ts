export interface Env {
  ATLAS_JOB: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;

  STEEL_API_KEY: string;
  ANTHROPIC_API_KEY: string;

  STEEL_BASE_URL?: string;
}
