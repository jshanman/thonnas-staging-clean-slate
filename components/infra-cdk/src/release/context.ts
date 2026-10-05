// @intent Shared release hook inputs; never infer the package from cwd

export interface ReleaseContext {
  projectRoot: string;
  env: string;
  packageDir?: string;
  component?: string;
  lib?: string;
  module?: string;
  strategyKey?: string;
  imageTag?: string;
  extras?: Record<string, unknown>;
  /** When set, rollback restores this generation instead of guessing previous. */
  restoreGenerationId?: string;
}



