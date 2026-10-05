import path from 'node:path';
import { collectDeploymentIntents } from '../planner/collector/deployment-intents';

export const parseStrategyFilter = (raw?: string): string[] | undefined => {
  if (!raw?.trim()) return undefined;
  const keys = [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
  return keys.length ? keys : undefined;
};

// @intent Expand omitted --target-component to every collected app package
export async function resolveReleaseJobs(
  projectRoot: string,
  env: string,
  options: { targetComponent?: string; lib?: string; module?: string },
): Promise<Array<{ targetComponent?: string; lib?: string; module?: string }>> {
  const targetComponents = parseStrategyFilter(options.targetComponent);
  const kinds = [targetComponents?.length ? 'target-component' : '', options.lib, options.module].filter(Boolean);
  if (kinds.length > 1) {
    throw new Error('thonnas release accepts only one of --target-component, --lib, or --module.');
  }
  if (options.lib) {
    return [{ lib: options.lib }];
  }
  if (options.module) {
    return [{ module: options.module }];
  }
  if (targetComponents?.length) {
    return targetComponents.map((key) => ({ targetComponent: key }));
  }
  const intents = await collectDeploymentIntents({ env, projectRoot });
  if (!intents.length) {
    throw new Error('No app packages with thonnas-infra.json to release under the project root.');
  }
  // @intent collectDeploymentIntents also scans .thonnas/libs/* (e.g. cicd-github-actions
  // declaring infra.identity.oidc as a capability it offers, not a release target) -- its
  // componentPath is the one reliable signal for which source an intent came from
  // (`components/<name>` vs `.thonnas/libs/<name>`, see deployment-intents.ts's two
  // buildIntentFromInfraFile call sites). Route lib-sourced intents through --lib, matching
  // findPackageDir's own split, instead of assuming every intent lives under components/.
  const libsPrefix = path.join('.thonnas', 'libs') + path.sep;
  return intents.map((intent) =>
    intent.componentPath.startsWith(libsPrefix)
      ? { lib: intent.component }
      : { targetComponent: intent.component },
  );
}

