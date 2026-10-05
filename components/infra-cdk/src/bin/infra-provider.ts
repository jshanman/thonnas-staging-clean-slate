#!/usr/bin/env node

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { ACMClient, ListCertificatesCommand, type CertificateSummary } from '@aws-sdk/client-acm';
import {
  CloudFrontClient,
  ListDistributionsCommand,
  type DistributionSummary,
} from '@aws-sdk/client-cloudfront';
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetBucketPolicyCommand,
  DeleteBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import {
  Route53Client,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { loadSharedConfigFiles } from '@aws-sdk/shared-ini-file-loader';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planInfrastructure, formatPlanSummaryLines, type InjectedAwsState } from '../planner/plan';
import type { PlanCertStatus } from '../planner/existing-state';
import { allTargetedBlocked, formatMatrixFailure, selectTargetStackIds } from '../planner/stack-status';
import { assertStacksSynthesized } from '../utils/cdk-manifest';

const execFileAsync = promisify(execFile);
import type { PlannedResource } from '../types';
import { isBootstrapped, markBootstrapped, BootstrapPermissionError } from '../utils/bootstrap-check';
import { resolveProjectName } from '../utils/root-domain';
import { owningStackName } from '../utils/cfn-ownership';
import { existingOacPolicyCoversImport, staleOacPolicyAction } from '../utils/static-site-oac';
import {
  LOG_GROUP_ORPHAN_CONTEXT_PREFIX,
  findOrphanServiceLogGroups,
  orphanLogGroupContext,
} from '../utils/orphan-log-groups';
import { runArtifactPostDeploy } from '../utils/artifact-post-deploy';
import { buildEnvProfile } from '../cdk/env-profiles';
import { assertEnvNotNamedRelease } from '../release/forbidden-env';
import { applyImageTagWarning } from '../release/apply-image-tag';
import { loadReleasedFargateContainers } from '../release/load-released-container';
import { executeRelease, executeRollback, runRollbackableBatch, bindingForStrategy, runReleaseForStrategy } from '../release/bindings';
import { buildReleaseContext } from '../release/load-target';
import { parseStrategyFilter, resolveReleaseJobs } from './resolve-release-jobs';
import { persistSuccessfulRelease, rollbackByReleaseId, formatHistoryTable } from '../release/receipt-run';
import { SsmReceiptStore } from '../release/receipt-store.ssm';

interface SharedInfraOptions {
  env: string;
  projectRoot?: string;
  rootDomain?: string;
  imageTag?: string;
  /** Git ref for compose-host checkout only (not hostnames/buckets). */
  gitTag?: string;
  /** Pre-validated slug for `{deploy-slug}` in hostnames and bucket templates. */
  deploySlug?: string;
  /** AWS account ID (e.g. 12-digit); from --account-id */
  accountId?: string;
  /** Region for CDK stacks (e.g. us-east-1); from --region */
  region?: string;
  dryRun?: boolean;
  /** CLI `--strategies` comma list (forwarded by `thonnas infra`). */
  strategies?: string;
  /** CLI `--target-component` comma list (app packages, not the provider key). */
  targetComponent?: string;
  /** Required on rollback; selects a persisted run receipt. */
  releaseId?: string;
}

type InfraAction = 'plan' | 'apply' | 'destroy' | 'identity-assume' | 'release' | 'rollback' | 'history';

// @intent Parse --strategies for filtered plan/apply/destroy
// @intent loadReleasedFargateContainers queries the LIVE ECS cluster/service by name (via
// wiringClusterName) -- it is not related to openReceiptStore's SSM-backed release/rollback
// history (a separate mechanism, used only by the `release`/`rollback`/`history` commands). The
// cluster name it queries MUST therefore match apply's own actual deployed-resource naming
// convention: the raw THONNAS_PROJECT_NAME env var, with no thonnas-package.json fallback (apply's
// stack-naming, below, never falls back either). Using resolveProjectName() here (which DOES fall
// back to the package name when the env var is empty) is wrong: with THONNAS_PROJECT_NAME left
// empty -- the correct setting for this project's no-prefix deployed stack/cluster names --
// resolveProjectName() still resolves a truthy package name, so this queried a cluster name that
// was never actually deployed ("TmpE2eClean7StagingWiring-cluster" instead of the real
// "StagingWiring-cluster"). DescribeServicesCommand against a nonexistent cluster throws, which
// this function's own try/catch silently swallows as "missing service on first apply is not an
// error" -- so applyReleasedContainer got `released: undefined` and dropped every previously
// deployed secret/env var (SECRET__API_GO_JWT_SECRET, SECRET__API_GO_INTERNAL_API_KEY) on every
// subsequent apply, even though the live service was healthy the whole time.
const releasedContainerLoader = (sharedOptions: SharedInfraOptions) => {
  if (!sharedOptions.region) return undefined;
  return async (components: string[]) => {
    return loadReleasedFargateContainers({
      region: sharedOptions.region as string,
      env: sharedOptions.env,
      projectName: process.env.THONNAS_PROJECT_NAME,
      components,
    });
  };
};

const program = new Command();
program.name('infra-cdk-provider');

const addSharedOptions = <T extends Command>(cmd: T) =>
  cmd
    .requiredOption('--env <env>', 'Target environment (development, beta, staging, production)')
    .option('--project-root <path>', 'Project root (for artifact paths; default: discovered from cwd)')
    .option('--root-domain <domain>', 'Root domain used for hostname generation')
    .option('--image-tag <tag>', 'ECR image tag to deploy', 'latest')
    .option('--git-tag <ref>', 'Git branch or tag for compose-host checkout only')
    .option('--deploy-slug <slug>', 'Deploy slug for {deploy-slug} in hostname and bucket patterns (pre-validated by Thonnas CLI)')
    .option('--account-id <account>', 'AWS account ID for CDK stacks (e.g. 12-digit ID)')
    .option('--region <region>', 'Cloud region for CDK stacks (e.g. us-east-1)')
    .option('--strategies <keys>', 'Comma-separated strategy keys to plan/apply/destroy')
    .option('--target-component <keys>', 'Comma-separated app component keys to include (aggregator filter)')
    .option('--dry-run', 'Simulate planner actions without writing artifacts', false);

addSharedOptions(program.command('plan').description('Plan infrastructure (detect what exists; run before apply)')).action(
  async (options) => {
    await runWithHandling('plan', options, async (sharedOptions, projectRoot) => {
      // Stack-naming project name must match `apply`'s resolution exactly (raw env var,
      // no thonnas-package.json fallback) -- otherwise `plan` synthesizes under a different
      // stack-name prefix than what `apply` actually deploys, which desyncs the
      // generated/{env}/cdk.out templates plan inspects from deployed reality.
      // releasedContainerLoader (above) uses this same raw-env-var convention now too, since it
      // queries the live ECS cluster by name -- it must match deployed reality, not a fallback.
      const projectName = process.env.THONNAS_PROJECT_NAME;
      const result = await planInfrastructure({
        env: sharedOptions.env,
        projectRoot,
        rootDomain: sharedOptions.rootDomain,
        dryRun: Boolean(sharedOptions.dryRun),
        imageTag: sharedOptions.imageTag,
        projectName: projectName ?? undefined,
        accountId: sharedOptions.accountId,
        strategyFilter: parseStrategyFilter(sharedOptions.strategies),
        targetComponents: parseStrategyFilter(sharedOptions.targetComponent),
        region: sharedOptions.region,
        gitTag: sharedOptions.gitTag,
        deploySlug: sharedOptions.deploySlug,
        existingState: await resolvePlanExistingState(sharedOptions.region, sharedOptions.rootDomain),
        resolveBucketExists: headBucketExistsMap(sharedOptions.region, sharedOptions.env),
        resolveReleasedContainers: releasedContainerLoader(sharedOptions),
      });

      if (!sharedOptions.dryRun && result.strategyResolution?.resources?.length) {
        const target = await resolveAwsTarget(sharedOptions);
        const regionForBucketCheck = target.region || 'us-east-1';
        const { bucketContextMap } = await resolveBucketExistsContext(
          result.strategyResolution.resources,
          regionForBucketCheck,
        );
        const artifactExists = await resolveArtifactExistsContext(
          result,
          sharedOptions.env,
          regionForBucketCheck,
        );
        const staticSiteExists = await resolveStaticSiteExistsContext(
          result.strategyResolution.resources,
          sharedOptions.env,
          regionForBucketCheck,
        );
        const staticSiteInfraExists = await resolveStaticSiteInfraExistsContext(
          result.strategyResolution.resources,
          regionForBucketCheck,
        );
        const planContextMap = {
          ...bucketContextMap,
          ...artifactExists,
          ...staticSiteExists,
          ...staticSiteInfraExists,
          ...orphanLogGroupContext(await findOrphanServiceLogGroups(regionForBucketCheck)),
        };
        await writeBucketExistsPlan(projectRoot, sharedOptions.env, planContextMap);
        printPlanSummary(sharedOptions.env, result, planContextMap);
      } else {
        printPlanSummary(sharedOptions.env, result);
      }
    });
  },
);

addSharedOptions(
  program.command('apply').description('Plan + deploy infrastructure via CDK'),
).action(async (options) => {
  await runWithHandling('apply', options, async (sharedOptions, projectRoot) => {
    const imageTagWarning = applyImageTagWarning(sharedOptions.imageTag);
    if (imageTagWarning) {
      logInfo(imageTagWarning);
    }
    const applyStrategyFilter = parseStrategyFilter(sharedOptions.strategies);
    const result = await planInfrastructure({
      env: sharedOptions.env,
      projectRoot,
      rootDomain: sharedOptions.rootDomain,
      imageTag: sharedOptions.imageTag,
      projectName: process.env.THONNAS_PROJECT_NAME,
      accountId: sharedOptions.accountId,
      region: sharedOptions.region,
      gitTag: sharedOptions.gitTag,
      deploySlug: sharedOptions.deploySlug,
      strategyFilter: applyStrategyFilter,
      targetComponents: parseStrategyFilter(sharedOptions.targetComponent),
      existingState: await resolvePlanExistingState(sharedOptions.region, sharedOptions.rootDomain),
      resolveBucketExists: headBucketExistsMap(sharedOptions.region, sharedOptions.env),
      resolveReleasedContainers: releasedContainerLoader(sharedOptions),
    });
    if (allTargetedBlocked(result.stackRows)) {
      const first = result.stackRows[0];
      throw new Error(
        formatMatrixFailure(first.rowId ?? 'all-blocked', first.stackId, 'all targeted stacks blocked; refusing cdk deploy --all'),
      );
    }
    if (
      applyStrategyFilter?.length &&
      !(result.strategyResolution?.components?.length || result.strategyResolution?.resources?.length)
    ) {
      throw new Error(
        `--strategies ${applyStrategyFilter.join(',')} matched no stacks; refusing to run cdk deploy --all`,
      );
    }
    const applyTargetComponents = parseStrategyFilter(sharedOptions.targetComponent);
    // @intent Deploy only the target's own stacks; dependencies are synthesized, not deployed
    const targetStackIds = applyTargetComponents?.length
      ? selectTargetStackIds(result.stackRows, applyTargetComponents, 'deploy')
      : undefined;
    if (applyStrategyFilter?.length) {
      logInfo(`[cdk] Deploying filtered strategies: ${applyStrategyFilter.join(',')}`);
    }
    if (applyTargetComponents?.length) {
      logInfo(`[cdk] Targeting --target-component: ${applyTargetComponents.join(',')} (dependencies synthesized, not deployed)`);
    }

    await ensureBootstrapIfPossible(sharedOptions, projectRoot, result.strategyResolution?.resources);
    const target = await resolveAwsTarget(sharedOptions);
    const regionForBucketCheck = target.region || 'us-east-1';
    let { bucketContextArgs, bucketContextMap } = await loadOrResolveBucketContext(
      projectRoot,
      sharedOptions.env,
      result.strategyResolution?.resources ?? [],
      regionForBucketCheck,
    );
    // @intent Always merge fresh static-site (and Lambda install) infra context on apply so we reuse existing resources
    const staticSiteResources = (result.strategyResolution?.resources ?? []).filter(
      (r) => r.kind === 's3StaticSiteDeployment' && r.props?.website_domain,
    );
    const storageTempUrlResources = (result.strategyResolution?.resources ?? []).filter(
      (r) => r.kind === 'storageTempUrlApi' && r.props?.api_domain,
    );
    const hasStaticOrLambdaSite = staticSiteResources.length > 0 || storageTempUrlResources.length > 0;
    if (hasStaticOrLambdaSite) {
      // Strip stale static-site infra keys from plan so a missing cert in ACM doesn't get overwritten by old ThonnasCertArn
      const staticSiteDomains = new Set([
        ...staticSiteResources.map((r) => r.props!.website_domain as string),
        ...storageTempUrlResources.map((r) => r.props!.api_domain as string),
      ]);
      const staticSiteKeys = [
        'ThonnasCertArn',
        'ThonnasCertPending',
        'ThonnasCertStatus',
        'ThonnasDistributionId',
        'ThonnasDistributionDomainName',
        'ThonnasSkipStaticSiteAlias',
      ];
      for (const key of Object.keys(bucketContextMap)) {
        const match = staticSiteKeys.some((prefix) => key.startsWith(prefix + ':'));
        const domainMatch = match && [...staticSiteDomains].some((d) => key.includes(d));
        if (domainMatch) delete bucketContextMap[key];
      }
      const staticSiteInfra = await resolveStaticSiteInfraExistsContext(
        result.strategyResolution!.resources,
        regionForBucketCheck,
      );
      bucketContextMap = { ...bucketContextMap, ...staticSiteInfra };
      bucketContextArgs = [];
      for (const [key, value] of Object.entries(bucketContextMap)) {
        bucketContextArgs.push('--context', `${key}=${value}`);
      }
      // Clear stale static-site cert keys from context file so CDK does not see old ThonnasCertArn
      await clearStaticSiteCertKeysFromContextFile(projectRoot, sharedOptions.env, staticSiteDomains);
    }
    // @intent Always re-resolve orphaned service log groups on apply; a stale 'true' would flip a
    // stack-owned log group to an import and drop it from its stack
    for (const key of Object.keys(bucketContextMap)) {
      if (key.startsWith(LOG_GROUP_ORPHAN_CONTEXT_PREFIX)) delete bucketContextMap[key];
    }
    const orphanLogGroups = await findOrphanServiceLogGroups(regionForBucketCheck);
    for (const name of orphanLogGroups) logInfo(`[cdk] Log group ${name} has no owning stack; adopting it`);
    bucketContextMap = { ...bucketContextMap, ...orphanLogGroupContext(orphanLogGroups) };
    bucketContextArgs = [];
    for (const [key, value] of Object.entries(bucketContextMap)) {
      bucketContextArgs.push('--context', `${key}=${value}`);
    }
    await clearContextKeysWithPrefix(projectRoot, sharedOptions.env, LOG_GROUP_ORPHAN_CONTEXT_PREFIX);
    await clearStaleOacBucketPolicies(bucketContextMap, regionForBucketCheck);
    await mergeBucketContextIntoFile(projectRoot, sharedOptions.env, bucketContextMap);
    await ensureCdkContextInAppDir(projectRoot, sharedOptions.env);
    const components = result.strategyResolution?.components ?? [];
    const resources = result.strategyResolution?.resources ?? [];
    const profile = buildEnvProfile(
      sharedOptions.env,
      components,
      sharedOptions.deploySlug,
      process.env.THONNAS_PROJECT_NAME,
    );
    // @intent Union plan create/update/import with static-site stacks (do not drop ECS/RDS)
    const deployStackNamesSet = new Set<string>();
    for (const row of result.stackRows) {
      if (row.status === 'create' || row.status === 'update' || row.status === 'import') {
        deployStackNamesSet.add(row.stackId);
      }
    }
    // @intent Always emit Artifact/SignedUrl stacks even when apply uploads are empty
    for (const r of resources) {
      if (r.kind === 's3ArtifactDeployment' && r.component) {
        deployStackNamesSet.add(`${profile.stackPrefix}${r.component}Artifact`);
      }
      if (r.kind === 'storageTempUrlApi' && r.component) {
        deployStackNamesSet.add(`${profile.stackPrefix}${r.component}SignedUrl`);
      }
    }
    if (result.artifactUploads.length > 0) {
      result.artifactUploads.forEach((u) => deployStackNamesSet.add(`${profile.stackPrefix}${u.component}Artifact`));
    }
    // Static-site stacks own CloudFront, viewer-request functions, OAC policy, and DNS.
    // Deploy them on every apply so config-only changes (for example accessControl) converge.
    staticSiteResources.forEach((r) => {
      if (r.component) deployStackNamesSet.add(`${profile.stackPrefix}${r.component}StaticSite`);
    });
    for (const [key, value] of Object.entries(bucketContextMap)) {
      if (key.startsWith('ThonnasARecordExists:') && value === 'false') {
        const domain = key.slice('ThonnasARecordExists:'.length);
        const staticRes = resources.find(
          (r) => r.kind === 's3StaticSiteDeployment' && (r.props?.website_domain as string) === domain && r.component,
        );
        if (staticRes?.component) {
          deployStackNamesSet.add(`${profile.stackPrefix}${staticRes.component}StaticSite`);
        }
        const websiteRes = resources.find(
          (r) => r.kind === 's3WebsiteBucket' && (r.props?.website_domain as string) === domain && r.component,
        );
        if (websiteRes?.component) {
          const hasStatic = resources.some(
            (r) => r.component === websiteRes.component && r.kind === 's3StaticSiteDeployment',
          );
          if (!hasStatic) {
            deployStackNamesSet.add(`${profile.stackPrefix}${websiteRes.component}Artifact`);
          }
        }
        const tempUrlRes = resources.find(
          (r) => r.kind === 'storageTempUrlApi' && (r.props?.api_domain as string) === domain && r.component,
        );
        if (tempUrlRes?.component) {
          deployStackNamesSet.add(`${profile.stackPrefix}${tempUrlRes.component}SignedUrl`);
        }
      }
    }
    const deployStackNames = deployStackNamesSet.size > 0 ? [...deployStackNamesSet] : undefined;
    const blockedStackIds = new Set(result.stackRows.filter((row) => row.status === 'blocked').map((row) => row.stackId));
    // @intent Allow deploy.beta / CI to target one stack (e.g. signed-url Lambda) without redeploying artifacts
    const explicitCdkStacksOverride = process.env.THONNAS_INFRA_CDK_STACKS?.trim();
    let deployStackNamesFinal: string[] | undefined = deployStackNames
      ? deployStackNames.filter((id) => !blockedStackIds.has(id))
      : undefined;
    if (explicitCdkStacksOverride) {
      deployStackNamesFinal = explicitCdkStacksOverride
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((id) => !blockedStackIds.has(id));
      if (deployStackNamesFinal.length === 0) deployStackNamesFinal = undefined;
      else logInfo(`[cdk] THONNAS_INFRA_CDK_STACKS: deploying only ${deployStackNamesFinal.join(', ')}`);
    } else if (targetStackIds) {
      deployStackNamesFinal = targetStackIds;
      logInfo(`[cdk] --target-component: deploying only ${targetStackIds.join(', ')}`);
    }
    const deployExclusively = Boolean((explicitCdkStacksOverride || targetStackIds) && deployStackNamesFinal?.length);
    try {
      await runCdkCommand(
        'deploy',
        projectRoot,
        result.cdkAppPath,
        sharedOptions.env,
        [
          '--require-approval',
          'never',
          // @intent When targeting explicit stacks, do not also update dependency stacks
          ...(deployExclusively ? ['--exclusively'] : []),
          ...bucketContextArgs,
        ],
        deployStackNamesFinal,
      );
    } catch (deployErr) {
      if (hasStaticOrLambdaSite && deployErr instanceof Error && deployErr.message.includes('exited with code')) {
        logError(
          '[cdk] Static site + CloudFront: ACM cert must be in us-east-1 and ISSUED. If the error is about the SSL certificate: (1) ensure the cert is in us-east-1 and DNS validation is complete (ACM console), or (2) create the cert in the console (us-east-1), run `thonnas infra plan --env ' +
            sharedOptions.env +
            '` then apply again to reuse it. New certs may need a second apply after validation completes.',
        );
      }
      throw deployErr;
    }
    if (targetStackIds && !explicitCdkStacksOverride) {
      await assertStacksSynthesized(
        path.join(projectRoot, 'components', 'infra-cdk', 'generated', sharedOptions.env, 'cdk.out'),
        targetStackIds,
        `--target-component ${applyTargetComponents!.join(',')}`,
      );
    }
    const hadPendingCert = Object.keys(bucketContextMap).some((k) => k.startsWith('ThonnasCertPending:'));
    if (hadPendingCert) {
      logError(`
*** NOT ALL RESOURCES WERE CREATED ***
The static site SSL certificate is still validating (PENDING_VALIDATION).
CloudFront and the DNS A record were skipped. Validation can take up to 30 minutes.

Next steps:
  1. Ensure the ACM validation CNAME is in Route53 (ACM console, us-east-1).
  2. Wait for the certificate to show "Issued" (often 1–30 minutes).
  3. Run: thonnas infra plan --env ${sharedOptions.env} && thonnas infra apply --env ${sharedOptions.env}
***`);
    }
    if (
      result.artifactUploads.length > 0 &&
      result.strategyResolution?.resources &&
      !explicitCdkStacksOverride
    ) {
      const post = await runArtifactPostDeploy(
        projectRoot,
        sharedOptions.env,
        result.artifactUploads,
        result.strategyResolution.resources,
      );
      if (post.copied > 0 || post.deleted > 0) {
        logInfo(`[artifact-post-deploy] copied=${post.copied} deleted=${post.deleted}`);
      }
      post.errors.forEach((err) => logError(`[artifact-post-deploy] ${err}`));
    }
    await persistCdkContextToGenerated(projectRoot, sharedOptions.env);
    await persistGithubOidcOutputs(projectRoot, sharedOptions.env);
    await verifyStaticSiteBucketPolicies(result.strategyResolution?.resources ?? []);
    logSuccess(`Infrastructure deployed for env "${sharedOptions.env}"`);
  });
});

program
  .command('identity-assume')
  .description('Assume a cloud deploy role via GitHub OIDC, or no-op if credentials already work')
  .requiredOption('--env <env>', 'Target environment (beta, release, prod, etc.)')
  .option('--project-root <path>', 'Project root (for project/config.json role ARN before config.resolve)')
  .action(async (options) => {
    await runWithHandling('identity-assume', options, async (sharedOptions, projectRoot) => {
      const { executeIdentityAssume } = await import('../identity/assume');
      const result = await executeIdentityAssume({
        env: sharedOptions.env,
        componentDir: process.cwd(),
        projectRoot,
      });
      if (result.outcome === 'oidc-assumed') {
        logSuccess(`Federated session established for env "${sharedOptions.env}"`);
      } else {
        logSuccess(`Existing AWS credentials are usable for env "${sharedOptions.env}" (no-op)`);
      }
    });
  });

addSharedOptions(program.command('destroy').description('Plan + destroy infrastructure via CDK'))
  .option('--yes', 'Accepted from thonnas -y; CDK destroy already uses --force')
  .action(async (options) => {
  await runWithHandling('destroy', options, async (sharedOptions, projectRoot) => {
    const strategyFilter = parseStrategyFilter(sharedOptions.strategies);
    const result = await planInfrastructure({
      env: sharedOptions.env,
      projectRoot,
      rootDomain: sharedOptions.rootDomain,
      imageTag: sharedOptions.imageTag,
      projectName: process.env.THONNAS_PROJECT_NAME,
      accountId: sharedOptions.accountId,
      region: sharedOptions.region,
      gitTag: sharedOptions.gitTag,
      deploySlug: sharedOptions.deploySlug,
      strategyFilter,
      targetComponents: parseStrategyFilter(sharedOptions.targetComponent),
    });
    if (strategyFilter?.length && !(result.strategyResolution?.components?.length || result.strategyResolution?.resources?.length)) {
      throw new Error(`--strategies ${strategyFilter.join(',')} matched no stacks; refusing to run cdk destroy --all`);
    }
    const destroyTargetComponents = parseStrategyFilter(sharedOptions.targetComponent);
    // @intent Destroy only the target's own stacks, never the dependencies planned alongside it
    const destroyStackIds = destroyTargetComponents?.length
      ? selectTargetStackIds(result.stackRows, destroyTargetComponents, 'destroy')
      : undefined;
    if (strategyFilter?.length) {
      logInfo(`[cdk] Destroying filtered strategies: ${strategyFilter.join(',')}`);
    }
    if (destroyTargetComponents?.length) {
      logInfo(`[cdk] Limiting aggregator to --target-component: ${destroyTargetComponents.join(',')}`);
    }

    await ensureBootstrapIfPossible(sharedOptions, projectRoot, result.strategyResolution?.resources);
    await runCdkCommand(
      'destroy',
      projectRoot,
      result.cdkAppPath,
      sharedOptions.env,
      destroyStackIds ? ['--force', '--exclusively'] : ['--force', '--all'],
      destroyStackIds,
    );
    logSuccess(`Infrastructure destroyed for env "${sharedOptions.env}"`);
  });
});

// @intent Artifact rollout: binding table + s3-cloudfront / ecs-fargate helpers
addSharedOptions(
  program
    .command('release')
    .description(
      'Roll artifacts onto existing bindings. --target-component/--lib/--module are optional filters. --component is the CLI provider key; do not pass it here.',
    ),
)
  .option('--component <key>', 'Not accepted; --component is the CLI provider key. Use --target-component.')
  .option('--lib <key>', 'Target lib key')
  .option('--module <key>', 'Target module key')
  .option('--strategy <key>', 'Resolved portable strategy key (from CLI collector)')
  .action(async (options) => {
    await runWithHandling('release', options, async (sharedOptions, projectRoot) => {
      if (options.component) {
        throw new Error(
          'Provider release does not take --component. Use --target-component for the app package. --component is the CLI provider key (infra-cdk).',
        );
      }
      const jobs = await resolveReleaseJobs(projectRoot, sharedOptions.env, options);
      const contexts = jobs.map((flags) =>
        buildReleaseContext(projectRoot, sharedOptions.env, {
          ...flags,
          strategy: options.strategy,
          imageTag: sharedOptions.imageTag,
        }),
      );

      // @intent --dry-run prints the exact release order (dependency-aware, per
      // collectDeploymentIntents) and what each job would do, without mutating anything or
      // persisting a release receipt -- reuses the same classification executeRelease itself
      // dispatches on (bindingForStrategy/runReleaseForStrategy), so this can never drift from
      // what a real run would actually do.
      if (sharedOptions.dryRun) {
        logInfo(`[release] --dry-run: would run ${contexts.length} job(s) in this order for env "${sharedOptions.env}":`);
        contexts.forEach((ctx, index) => {
          const identity = ctx.component ?? (ctx.lib ? `lib:${ctx.lib}` : ctx.module ? `module:${ctx.module}` : '(unresolved)');
          const binding = ctx.strategyKey ? bindingForStrategy(ctx.strategyKey) : undefined;
          const classification = runReleaseForStrategy(ctx.strategyKey);
          const action =
            classification.kind === 'not-implemented'
              ? `would call executeRelease() -> ${binding} binding (mutates AWS)`
              : classification.message;
          logInfo(
            `  ${index + 1}. ${identity}  strategy=${ctx.strategyKey ?? '(none)'}  binding=${binding ?? '(none)'}  -> ${action}`,
          );
        });
        return;
      }

      const results = await runRollbackableBatch(contexts, executeRelease, executeRollback);
      for (const result of results) {
        if (result.kind === 'not-implemented') {
          logInfo(`[release] skip: ${result.message}`);
          continue;
        }
        logSuccess(result.message);
      }
      const { store } = await openReceiptStore(projectRoot, sharedOptions.env, sharedOptions.region);
      const receipt = await persistSuccessfulRelease({
        store,
        env: sharedOptions.env,
        projectRoot,
        results,
        contexts,
      });
      logSuccess(`releaseId ${receipt.releaseId}`);
    });
  });

addSharedOptions(
  program
    .command('rollback')
    .description(
      'Restore the generation named by --release-id. Same filters as release. --component is the CLI provider key; do not pass it here.',
    ),
)
  .requiredOption('--release-id <id>', 'Persisted run receipt to undo (required; list with history)')
  .option('--component <key>', 'Not accepted; --component is the CLI provider key. Use --target-component.')
  .option('--lib <key>', 'Target lib key')
  .option('--module <key>', 'Target module key')
  .option('--strategy <key>', 'Resolved portable strategy key (from CLI collector)')
  .action(async (options) => {
    await runWithHandling('rollback', options, async (sharedOptions, projectRoot) => {
      if (options.component) {
        throw new Error(
          'Provider rollback does not take --component. Use --target-component for the app package. --component is the CLI provider key (infra-cdk).',
        );
      }
      const releaseId = String(sharedOptions.releaseId ?? options.releaseId ?? '').trim();
      if (!releaseId) {
        throw new Error('Missing required --release-id. List ids with thonnas release history --env.');
      }
      const jobs = await resolveReleaseJobs(projectRoot, sharedOptions.env, options);
      const contexts = jobs.map((flags) =>
        buildReleaseContext(projectRoot, sharedOptions.env, {
          ...flags,
          strategy: options.strategy,
          imageTag: sharedOptions.imageTag,
        }),
      );
      const { store } = await openReceiptStore(projectRoot, sharedOptions.env, sharedOptions.region);
      const next = await rollbackByReleaseId({
        store,
        releaseId,
        env: sharedOptions.env,
        projectRoot,
        contexts,
        rollback: executeRollback,
      });
      logSuccess(`releaseId ${next.releaseId}`);
    });
  });

addSharedOptions(
  program
    .command('history')
    .description('List SSM release receipts for --env. --component is the CLI provider key; do not pass it here.'),
)
  .option('--component <key>', 'Not accepted; --component is the CLI provider key.')
  .action(async (options) => {
    await runWithHandling('history', options, async (sharedOptions, projectRoot) => {
      if (options.component) {
        throw new Error(
          'Provider history does not take --component. --component is the CLI provider key (infra-cdk).',
        );
      }
      const { store } = await openReceiptStore(projectRoot, sharedOptions.env, sharedOptions.region);
      const receipts = await store.list();
      logSuccess(formatHistoryTable(receipts));
    });
  });

program.parseAsync(process.argv).catch((error) => {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

// @intent Never let a generated .env.{env} file (a stale, one-time snapshot from whatever
// credentials were ambient at `thonnas config setup` time) silently override or coexist with
// the operator's real AWS credentials for the current run — this previously caused `cdk deploy`
// to target the wrong AWS account despite AWS_PROFILE being set correctly on the command.
const AWS_CREDENTIAL_ENV_BLOCKLIST = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']);

// @intent Load component .env.{env} so THONNAS_COMPOSE_* and other thonnas-config vars are available at deploy time
async function loadComponentEnv(projectRoot: string, env: string, componentDirName?: string): Promise<void> {
  const componentDir = componentDirName
    ? path.join(projectRoot, 'components', componentDirName)
    : path.join(projectRoot, 'components', 'infra-cdk');
  const envPath = path.join(componentDir, `.env.${env}`);
  if (!existsSync(envPath)) {
    return;
  }
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (AWS_CREDENTIAL_ENV_BLOCKLIST.has(key)) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
      else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/\\'/g, "'");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // ignore missing or unreadable .env
  }
}

async function runWithHandling(
  action: InfraAction,
  rawOptions: SharedInfraOptions,
  handler: (options: SharedInfraOptions, projectRoot: string) => Promise<void>,
): Promise<void> {
  if (action !== 'release' && action !== 'rollback' && action !== 'history') {
    ensureRuntimeBuild();
  }
  // @intent Use project root (--project-root from CLI) for all path resolution; same as thonnas project root
  const projectRoot = rawOptions.projectRoot ? path.resolve(rawOptions.projectRoot) : path.resolve(findRepoRoot(process.cwd()));
  const options = sanitizeOptions(rawOptions);
  assertEnvNotNamedRelease(options.env);
  await loadComponentEnv(projectRoot, options.env);
  // @intent Belt-and-suspenders: if the operator selected a profile, never let stray static
  // credentials (from any source) coexist with it — AWS's own SDK precedence between
  // AWS_PROFILE and AWS_ACCESS_KEY_ID/SECRET is explicitly documented as unstable across
  // versions, and `cdk deploy` resolves credentials via a separate dependency tree that may
  // not agree with this process's own SDK clients.
  if (process.env.AWS_PROFILE) {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  }
  try {
    await handler(options, projectRoot);
  } catch (error) {
    logError(`[${action}] ${(error as Error).message}`);
    throw error;
  }
}

function sanitizeOptions(options: SharedInfraOptions): SharedInfraOptions {
  return {
    env: options.env,
    projectRoot: options.projectRoot,
    rootDomain: options.rootDomain,
    imageTag: options.imageTag,
    gitTag: options.gitTag,
    deploySlug: options.deploySlug,
    accountId: options.accountId,
    region: options.region,
    dryRun: Boolean(options.dryRun),
    strategies: options.strategies,
    targetComponent: options.targetComponent,
    releaseId: options.releaseId,
  };
}

// @intent Open SSM receipt store; project name is env/config, never cwd
async function openReceiptStore(
  projectRoot: string,
  env: string,
  region?: string,
): Promise<{ store: SsmReceiptStore; project: string }> {
  const project = await resolveProjectName(projectRoot, env);
  if (!project) {
    throw new Error(
      'Set THONNAS_PROJECT_NAME or project/config.json THONNAS_PROJECT_NAME; cwd is not the project name.',
    );
  }
  const resolvedRegion = region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  return { store: new SsmReceiptStore({ project, env, region: resolvedRegion }), project };
}

function ensureRuntimeBuild(): void {
  const runtimePath = path.resolve(__dirname, '../cdk/runtime.js');
  if (!existsSync(runtimePath)) {
    logError('CDK runtime missing. Run `npm run build` inside components/infra-cdk before continuing.');
    process.exit(1);
  }
}

function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (!existsSync(path.join(current, 'components'))) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Unable to locate repository root (missing "components" directory)');
    }
    current = parent;
  }
  return current;
}

/** Collect bucket name per component for artifact stacks (same logic as ArtifactStack). */
function getArtifactBucketMeta(resources: PlannedResource[]): { bucketName: string }[] {
  const byComponent = new Map<string, { website?: PlannedResource; deploy?: PlannedResource; static?: PlannedResource }>();
  for (const r of resources) {
    if (r.kind === 's3WebsiteBucket' && r.component) {
      const cur = byComponent.get(r.component) ?? {};
      cur.website = r;
      byComponent.set(r.component, cur);
    }
    if (r.kind === 's3ArtifactDeployment' && r.component) {
      const cur = byComponent.get(r.component) ?? {};
      cur.deploy = r;
      byComponent.set(r.component, cur);
    }
    if (r.kind === 's3StaticSiteDeployment' && r.component) {
      const cur = byComponent.get(r.component) ?? {};
      cur.static = r;
      byComponent.set(r.component, cur);
    }
  }
  const out: { bucketName: string }[] = [];
  for (const { website, deploy, static: staticSite } of byComponent.values()) {
    const bucketName =
      (deploy?.props?.bucket as string) ??
      (website?.props?.bucket as string) ??
      (staticSite?.props?.bucket as string) ??
      (website?.props?.website_domain as string) ??
      (staticSite?.props?.website_domain as string) ??
      '';
    if (!bucketName) continue;
    out.push({ bucketName });
  }
  return out;
}

// @intent Collect infra.storage bucket names (ComposeHost / StorageStack) for HeadBucket reuse
function getStorageBucketMeta(resources: PlannedResource[]): { bucketName: string }[] {
  const seen = new Set<string>();
  const out: { bucketName: string }[] = [];
  for (const r of resources) {
    if (r.kind !== 's3StorageBucket') continue;
    const raw =
      (r.props?.bucket as string | undefined) ??
      (r.props?.bucketName as string | undefined) ??
      '';
    const bucketName = typeof raw === 'string' ? raw.trim() : '';
    if (!bucketName || seen.has(bucketName)) continue;
    seen.add(bucketName);
    out.push({ bucketName });
  }
  return out;
}

/** Unique bucket names for artifact + infra.storage existence checks (same ThonnasBucketExists context key). */
function getAllBucketsForExistenceCheck(resources: PlannedResource[]): { bucketName: string }[] {
  const seen = new Set<string>();
  const merged: { bucketName: string }[] = [];
  for (const { bucketName } of [...getArtifactBucketMeta(resources), ...getStorageBucketMeta(resources)]) {
    if (seen.has(bucketName)) continue;
    seen.add(bucketName);
    merged.push({ bucketName });
  }
  return merged;
}

/**
 * Resolve CDK context so we never fail with NAME_CONFLICT_VALIDATION when a bucket already exists.
 * For every artifact-stack and infra.storage bucket, HeadBucket in AWS; if it exists, pass ThonnasBucketExists=true
 * so stacks use fromBucketName (reuse). Tries primary region and us-east-1 so buckets
 * for static-site stacks (us-east-1) are found. Returns both CLI args and a map for cdk.context.json.
 */
async function resolveBucketExistsContext(
  resources: PlannedResource[],
  region: string,
): Promise<{ bucketContextArgs: string[]; bucketContextMap: Record<string, string> }> {
  const meta = getAllBucketsForExistenceCheck(resources);
  const bucketContextArgs: string[] = [];
  const bucketContextMap: Record<string, string> = {};
  if (meta.length === 0) return { bucketContextArgs, bucketContextMap };

  const regionsToTry = region === 'us-east-1' ? ['us-east-1'] : [region, 'us-east-1'];
  logInfo(`[cdk] Checking ${meta.length} S3 bucket(s) for existence (artifact + storage; regions: ${regionsToTry.join(', ')})`);

  for (const { bucketName } of meta) {
    const key = `ThonnasBucketExists:${bucketName}`;
    let exists = false;
    let lastError: string | undefined;
    for (const r of regionsToTry) {
      try {
        const s3 = new S3Client({ region: r });
        await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
        exists = true;
        logInfo(`[cdk] Bucket ${bucketName} exists (checked ${r})`);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        logInfo(`[cdk] Bucket ${bucketName} HeadBucket(${r}): ${msg}`);
      }
    }
    if (!exists) {
      logInfo(`[cdk] Bucket ${bucketName} not found, will create (last error: ${lastError ?? 'n/a'})`);
    }
    const value = exists ? 'true' : 'false';
    bucketContextArgs.push('--context', `${key}=${value}`);
    bucketContextMap[key] = value;
  }
  return { bucketContextArgs, bucketContextMap };
}

/**
 * Check S3 for artifact deploy keys; if all expected keys exist, set ThonnasArtifactExists:${env}-${component}=true
 * so the stack skips BucketDeployment (create-only-if-not-exists).
 */
async function resolveArtifactExistsContext(
  result: { artifactUploads: { component: string; version: string; paths: string[] }[]; strategyResolution: { resources: PlannedResource[] } },
  env: string,
  region: string,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (result.artifactUploads.length === 0) return map;
  const regionsToTry = region === 'us-east-1' ? ['us-east-1'] : [region, 'us-east-1'];
  for (const upload of result.artifactUploads) {
    const deployRes = result.strategyResolution.resources.find(
      (r) => r.kind === 's3ArtifactDeployment' && r.component === upload.component,
    );
    if (!deployRes?.props?.bucket || upload.paths.length === 0) continue;
    const bucket = deployRes.props.bucket as string;
    const prefix = (deployRes.props.prefix as string) ?? env;
    let allExist = true;
    for (const filePath of upload.paths) {
      const key = `${prefix}/${upload.version}/${path.basename(filePath)}`;
      let found = false;
      for (const r of regionsToTry) {
        try {
          const s3 = new S3Client({ region: r });
          await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          found = true;
          break;
        } catch {
          // try next region or mark missing
        }
      }
      if (!found) {
        allExist = false;
        break;
      }
    }
    const contextKey = `ThonnasArtifactExists:${env}-${upload.component}`;
    map[contextKey] = allExist ? 'true' : 'false';
    if (allExist) logInfo(`[cdk] Artifact content already in S3 for ${upload.component}, will skip upload`);
  }
  return map;
}

// @intent Report origin occupancy only; never imply apply will upload static files
async function resolveStaticSiteExistsContext(
  resources: PlannedResource[],
  env: string,
  region: string,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const staticResources = resources.filter((r) => r.kind === 's3StaticSiteDeployment' && r.component);
  if (staticResources.length === 0) return map;
  const regionsToTry = region === 'us-east-1' ? ['us-east-1'] : [region, 'us-east-1'];
  for (const res of staticResources) {
    const bucket =
      (res.props?.bucket as string) ??
      (res.props?.website_domain as string) ??
      '';
    if (!bucket) continue;
    let found = false;
    for (const r of regionsToTry) {
      try {
        const s3 = new S3Client({ region: r });
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: 'index.html' }));
        found = true;
        break;
      } catch {
        // continue
      }
    }
    const contextKey = `ThonnasStaticSiteExists:${env}-${res.component}`;
    map[contextKey] = found ? 'true' : 'false';
    if (found) {
      logInfo(
        `[cdk] Static site index.html already present for ${res.component}; apply does not upload files (use thonnas release)`,
      );
    }
  }
  return map;
}

/**
 * For each static site, check if ACM cert, CloudFront distribution, OAC bucket policy, and Route53 A record exist.
 * Also runs A-record check for website/artifact buckets (s3WebsiteBucket) so sea.thonnas.* etc. get DNS when missing.
 * Sets ThonnasCertArn, ThonnasDistributionId, ThonnasBucketPolicyHasOAC, ThonnasARecordExists (per domain/bucket).
 */
async function resolveStaticSiteInfraExistsContext(
  resources: PlannedResource[],
  region: string,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const staticResources = resources.filter((r) => r.kind === 's3StaticSiteDeployment' && r.component && r.props?.website_domain);
  const websiteBucketResources = resources.filter((r) => r.kind === 's3WebsiteBucket' && r.props?.website_domain && r.props?.hosted_zone_domain);
  const storageTempUrlResources = resources.filter(
    (r) => r.kind === 'storageTempUrlApi' && r.props?.api_domain && r.props?.hosted_zone_domain,
  );
  if (
    staticResources.length === 0 &&
    websiteBucketResources.length === 0 &&
    storageTempUrlResources.length === 0
  ) {
    return map;
  }
  const byComponent = new Map<string, { deploy?: PlannedResource; website?: PlannedResource }>();
  for (const r of resources) {
    if (r.kind === 's3ArtifactDeployment' && r.component) byComponent.set(r.component, { ...byComponent.get(r.component), deploy: r });
    if (r.kind === 's3WebsiteBucket' && r.component) byComponent.set(r.component, { ...byComponent.get(r.component), website: r });
  }
  const acmRegion = 'us-east-1';
  const acmClient = new ACMClient({ region: acmRegion });
  const cfClient = new CloudFrontClient({ region: 'us-east-1' });
  const s3Client = new S3Client({ region: region === 'us-east-1' ? 'us-east-1' : region });
  const route53Client = new Route53Client({ region: 'us-east-1' });

  const runARecordCheck = async (website_domain: string, hosted_zone_domain: string): Promise<void> => {
    if (map[`ThonnasARecordExists:${website_domain}`] !== undefined) return;
    if (!hosted_zone_domain) return;
    try {
      const zoneName = hosted_zone_domain.endsWith('.') ? hosted_zone_domain : `${hosted_zone_domain}.`;
      const zoneList = await route53Client.send(new ListHostedZonesCommand({}));
      const zone = zoneList.HostedZones?.find((z) => z.Name === zoneName);
      if (zone?.Id) {
        const recordName = website_domain.endsWith('.') ? website_domain : `${website_domain}.`;
        const rr = await route53Client.send(
          new ListResourceRecordSetsCommand({
            HostedZoneId: zone.Id,
            MaxItems: 10,
            StartRecordName: recordName,
            StartRecordType: 'A',
          }),
        );
        const hasARecord =
          rr.ResourceRecordSets?.some(
            (r) => r.Name === recordName && (r.Type === 'A' || r.Type === 'AAAA'),
          ) ?? false;
        map[`ThonnasARecordExists:${website_domain}`] = hasARecord ? 'true' : 'false';
        if (hasARecord) logInfo(`[cdk] Route53 A record already exists for ${website_domain}, will skip`);
      } else {
        map[`ThonnasARecordExists:${website_domain}`] = 'false';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logInfo(`[cdk] Route53 check for ${website_domain}: ${msg}`);
      map[`ThonnasARecordExists:${website_domain}`] = 'false';
    }
  };

  for (const res of staticResources) {
    const website_domain = res.props!.website_domain as string;
    const hosted_zone_domain = (res.props?.hosted_zone_domain as string) || '';
    const bucket =
      (byComponent.get(res.component!)?.deploy?.props?.bucket as string) ??
      (byComponent.get(res.component!)?.website?.props?.website_domain as string) ??
      (res.props?.website_domain as string) ??
      '';
    if (!website_domain) continue;

    try {
      const [issuedList, pendingList] = await Promise.all([
        acmClient.send(new ListCertificatesCommand({ CertificateStatuses: ['ISSUED'] })),
        acmClient.send(new ListCertificatesCommand({ CertificateStatuses: ['PENDING_VALIDATION'] })),
      ]);
      const issuedCert = issuedList.CertificateSummaryList?.find((c: CertificateSummary) => c.DomainName === website_domain);
      const pendingCert = pendingList.CertificateSummaryList?.find((c: CertificateSummary) => c.DomainName === website_domain);
      if (issuedCert?.CertificateArn) {
        map[`ThonnasCertArn:${website_domain}`] = issuedCert.CertificateArn;
        map[`ThonnasCertStatus:${website_domain}`] = 'ISSUED';
        logInfo(`[cdk] ACM cert already exists (ISSUED) for ${website_domain}, will reuse`);
      } else if (pendingCert?.CertificateArn) {
        map[`ThonnasCertArn:${website_domain}`] = pendingCert.CertificateArn;
        map[`ThonnasCertPending:${website_domain}`] = 'true';
        // Do not set ThonnasCertStatus so stack skips CloudFront until cert is ISSUED
        logError(
          `[cdk] *** SSL CERT PENDING: Not all resources will be created. *** ACM cert for ${website_domain} is still validating. Add the CNAME in Route53 (see ACM console). Validation can take up to 30 minutes. Then run plan and apply again (same --env).`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logInfo(`[cdk] ACM list certs for ${website_domain}: ${msg}`);
    }

    await runARecordCheck(website_domain, hosted_zone_domain);

    // @intent Import leftover CF; keep managing when StaticSite owns the dist
    let importedDistributionArn: string | undefined;
    try {
      const distList = await cfClient.send(new ListDistributionsCommand({ MaxItems: 100 }));
      const items = distList.DistributionList?.Items ?? [];
      const dist = items.find((d: DistributionSummary) => d.Aliases?.Items?.includes(website_domain));
      if (dist?.Id && dist.ARN) {
        const ownedByStaticSite = await isDistributionOwnedByStaticSite(dist.Id, region);
        if (ownedByStaticSite) {
          logInfo(`[cdk] CloudFront distribution already exists for ${website_domain} (StaticSite-managed)`);
        } else {
          map[`ThonnasDistributionId:${website_domain}`] = dist.Id;
          importedDistributionArn = dist.ARN;
          if (dist.DomainName) {
            map[`ThonnasDistributionDomainName:${website_domain}`] = dist.DomainName;
          }
          logInfo(
            `[cdk] CloudFront distribution ${dist.Id} for ${website_domain} is leftover-owned; StaticSite will import it`,
          );
          if (map[`ThonnasARecordExists:${website_domain}`] === 'true') {
            map[`ThonnasSkipStaticSiteAlias:${website_domain}`] = 'true';
            logInfo(`[cdk] Skipping new Route53 A for ${website_domain}; leftover alias still points at ${dist.Id}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logInfo(`[cdk] CloudFront list distributions for ${website_domain}: ${msg}`);
    }

    if (bucket) {
      try {
        const policyResp = await s3Client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        // @intent A bucket policy's CloudFormation physical id is its bucket name
        const hasOAC = existingOacPolicyCoversImport({
          policyJson: policyResp.Policy,
          policyOwner: await owningStackName(bucket, region),
          importedDistributionArn,
        });
        map[`ThonnasBucketPolicyHasOAC:${bucket}`] = hasOAC ? 'true' : 'false';
        logInfo(
          hasOAC
            ? `[cdk] Bucket ${bucket} already grants imported distribution via OAC policy, will skip`
            : `[cdk] Bucket ${bucket} OAC policy will be managed by StaticSite`,
        );
      } catch {
        map[`ThonnasBucketPolicyHasOAC:${bucket}`] = 'false';
      }
    }
  }

  for (const res of websiteBucketResources) {
    const website_domain = res.props!.website_domain as string;
    const hosted_zone_domain = (res.props?.hosted_zone_domain as string) || '';
    if (website_domain && hosted_zone_domain) await runARecordCheck(website_domain, hosted_zone_domain);
  }

  for (const res of storageTempUrlResources) {
    const api_domain = res.props!.api_domain as string;
    const hosted_zone_domain = (res.props?.hosted_zone_domain as string) || '';
    if (!api_domain || !hosted_zone_domain) continue;
    try {
      const [issuedList, pendingList] = await Promise.all([
        acmClient.send(new ListCertificatesCommand({ CertificateStatuses: ['ISSUED'] })),
        acmClient.send(new ListCertificatesCommand({ CertificateStatuses: ['PENDING_VALIDATION'] })),
      ]);
      const issuedCert = issuedList.CertificateSummaryList?.find((c: CertificateSummary) => c.DomainName === api_domain);
      const pendingCert = pendingList.CertificateSummaryList?.find((c: CertificateSummary) => c.DomainName === api_domain);
      if (issuedCert?.CertificateArn) {
        map[`ThonnasCertArn:${api_domain}`] = issuedCert.CertificateArn;
        map[`ThonnasCertStatus:${api_domain}`] = 'ISSUED';
        logInfo(`[cdk] ACM cert already exists (ISSUED) for ${api_domain}, will reuse`);
      } else if (pendingCert?.CertificateArn) {
        map[`ThonnasCertArn:${api_domain}`] = pendingCert.CertificateArn;
        map[`ThonnasCertPending:${api_domain}`] = 'true';
        logError(
          `[cdk] *** SSL CERT PENDING: Not all resources will be created. *** ACM cert for ${api_domain} is still validating. Add the CNAME in Route53. Then run plan and apply again.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logInfo(`[cdk] ACM list certs for ${api_domain}: ${msg}`);
    }
    await runARecordCheck(api_domain, hosted_zone_domain);
  }
  return map;
}

const BUCKET_EXISTS_PLAN_FILE = 'bucket-exists-context.json';

/** Write bucket-exists context from plan to generated/{env}/ so apply can reuse it. */
async function writeBucketExistsPlan(
  projectRoot: string,
  env: string,
  bucketContextMap: Record<string, string>,
): Promise<void> {
  if (Object.keys(bucketContextMap).length === 0) return;
  const outDir = path.join(projectRoot, 'components', 'infra-cdk', 'generated', env);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, BUCKET_EXISTS_PLAN_FILE);
  await fs.writeFile(outPath, `${JSON.stringify(bucketContextMap, null, 2)}\n`, 'utf8');
  logInfo(`[cdk] Wrote ${path.relative(path.join(projectRoot, 'components', 'infra-cdk'), outPath)} (plan output for apply)`);
}

/**
 * Load non-bucket plan context from disk; always re-run HeadBucket for ThonnasBucketExists:* so
 * infra.storage buckets and stale plan files cannot skip checks.
 */
async function loadOrResolveBucketContext(
  projectRoot: string,
  env: string,
  resources: PlannedResource[],
  region: string,
): Promise<{ bucketContextArgs: string[]; bucketContextMap: Record<string, string> }> {
  const planPath = path.join(projectRoot, 'components', 'infra-cdk', 'generated', env, BUCKET_EXISTS_PLAN_FILE);
  let fromPlan: Record<string, string> = {};
  try {
    const raw = await fs.readFile(planPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed && typeof parsed === 'object') fromPlan = parsed;
  } catch {
    // no plan output or invalid
  }
  const withoutBucketExists: Record<string, string> = {};
  for (const [k, v] of Object.entries(fromPlan)) {
    if (!k.startsWith('ThonnasBucketExists:')) withoutBucketExists[k] = v;
  }
  if (Object.keys(fromPlan).length > 0) {
    logInfo(`[cdk] Merging plan context from ${planPath} (ThonnasBucketExists:* refreshed via HeadBucket)`);
  }
  if (resources.length === 0) {
    const bucketContextArgs: string[] = [];
    for (const [key, value] of Object.entries(withoutBucketExists)) {
      bucketContextArgs.push('--context', `${key}=${value}`);
    }
    return { bucketContextArgs, bucketContextMap: withoutBucketExists };
  }
  const fresh = await resolveBucketExistsContext(resources, region);
  const bucketContextMap = { ...withoutBucketExists, ...fresh.bucketContextMap };
  const bucketContextArgs: string[] = [];
  for (const [key, value] of Object.entries(bucketContextMap)) {
    bucketContextArgs.push('--context', `${key}=${value}`);
  }
  return { bucketContextArgs, bucketContextMap };
}

/** After deploy: verify static-site buckets have an OAC bucket policy so CloudFront can read; log warning if missing. */
async function verifyStaticSiteBucketPolicies(resources: PlannedResource[]): Promise<void> {
  const buckets = resources
    .filter((r) => r.kind === 's3StaticSiteDeployment' && r.props?.website_domain)
    .map((r) => r.props!.website_domain as string);
  if (buckets.length === 0) return;
  const s3 = new S3Client({ region: 'us-east-1' });
  for (const bucketName of buckets) {
    try {
      const out = await s3.send(new GetBucketPolicyCommand({ Bucket: bucketName }));
      const policy = out.Policy ? JSON.parse(out.Policy) : {};
      const hasOAC =
        Array.isArray(policy.Statement) &&
        policy.Statement.some(
          (s: { Sid?: string }) => s.Sid === 'AllowCloudFrontOAC' || (s.Sid && String(s.Sid).includes('CloudFront')),
        );
      if (!hasOAC) {
        logError(
          `[verify] Bucket ${bucketName} has a policy but no AllowCloudFrontOAC statement; CloudFront may get 403. Re-run infra apply.`,
        );
      } else {
        logInfo(`[verify] Bucket ${bucketName} has OAC policy OK`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NoSuchBucketPolicy') || (err as { name?: string })?.name === 'NoSuchBucketPolicy') {
        logError(
          `[verify] Bucket ${bucketName} has no bucket policy; CloudFront will get 403. Ensure the stack includes CfnBucketPolicy and re-run infra apply.`,
        );
      } else {
        logInfo(`[verify] Bucket ${bucketName} policy check skipped: ${msg}`);
      }
    }
  }
}

const CDK_CONTEXT_FILENAME = 'cdk.context.json';

const STATIC_SITE_CERT_KEY_PREFIXES = [
  'ThonnasCertArn:',
  'ThonnasCertPending:',
  'ThonnasCertStatus:',
  'ThonnasDistributionId:',
  'ThonnasDistributionDomainName:',
  'ThonnasSkipStaticSiteAlias:',
];

// @intent Tag leftover Artifact CF as import; StaticSite-owned dist stays stack-managed
async function isDistributionOwnedByStaticSite(distributionId: string, region: string): Promise<boolean> {
  // @intent Ask CloudFormation, not the aws:cloudformation:* tags -- CloudFront distributions
  // created by CloudFormation do not carry them, so a tag check called every StaticSite-owned
  // distribution "leftover", the stack imported it, and CloudFormation deleted the live site.
  // Unknown ownership counts as owned: importing an owned distribution deletes it.
  const regions = region === 'us-east-1' ? ['us-east-1'] : [region, 'us-east-1'];
  for (const r of regions) {
    const owner = await owningStackName(distributionId, r);
    if (owner === undefined) {
      logInfo(`[cdk] CloudFront ${distributionId} ownership unknown in ${r}; treating as StaticSite-managed`);
      return true;
    }
    if (owner) return owner.endsWith('StaticSite');
  }
  return false;
}

/** Remove stale static-site cert keys from context file so synth uses fresh state (e.g. no ThonnasCertArn when ACM has 0 certs). */
async function clearStaticSiteCertKeysFromContextFile(
  projectRoot: string,
  env: string,
  staticSiteDomains: Set<string>,
): Promise<void> {
  const contextPath = path.join(projectRoot, 'components', 'infra-cdk', 'generated', env, CDK_CONTEXT_FILENAME);
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(contextPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  let changed = false;
  for (const key of Object.keys(existing)) {
    const isStaticSiteCertKey = STATIC_SITE_CERT_KEY_PREFIXES.some((p) => key.startsWith(p));
    const forOurDomain = isStaticSiteCertKey && [...staticSiteDomains].some((d) => key.includes(d));
    if (forOurDomain) {
      delete existing[key];
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(contextPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  }
}

/**
 * Apply-only: delete an unowned, OAC-only bucket policy that StaticSite is about to replace --
 * CloudFormation cannot create AWS::S3::BucketPolicy over an existing policy (see staleOacPolicyAction).
 */
async function clearStaleOacBucketPolicies(contextMap: Record<string, string>, region: string): Promise<void> {
  const prefix = 'ThonnasBucketPolicyHasOAC:';
  const s3 = new S3Client({ region });
  for (const [key, value] of Object.entries(contextMap)) {
    if (!key.startsWith(prefix)) continue;
    const bucket = key.slice(prefix.length);
    let policyJson: string | undefined;
    try {
      policyJson = (await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy;
    } catch {
      continue; // no policy (or unreadable): nothing to clear
    }
    const action = staleOacPolicyAction({
      policyJson,
      policyOwner: await owningStackName(bucket, region),
      stackSkipsPolicy: value === 'true',
    });
    if (action === 'delete') {
      logInfo(`[cdk] Removing stale unowned OAC bucket policy on ${bucket}; StaticSite will create and own it`);
      await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    } else if (action === 'conflict') {
      throw new Error(
        `Bucket ${bucket} has a bucket policy no stack owns with statements besides AllowCloudFrontOAC; ` +
          'StaticSite cannot create its OAC policy over it. Merge or remove that policy, then re-run apply.',
      );
    }
  }
}

/** Drop every key with this prefix from generated/{env}/cdk.context.json before a fresh merge. */
async function clearContextKeysWithPrefix(projectRoot: string, env: string, prefix: string): Promise<void> {
  const contextPath = path.join(projectRoot, 'components', 'infra-cdk', 'generated', env, CDK_CONTEXT_FILENAME);
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await fs.readFile(contextPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  const kept = Object.fromEntries(Object.entries(existing).filter(([key]) => !key.startsWith(prefix)));
  if (Object.keys(kept).length !== Object.keys(existing).length) {
    await fs.writeFile(contextPath, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
  }
}

/** Merge bucket-exists context into generated/{env}/cdk.context.json (single source of truth; generated/ is gitignored). */
async function mergeBucketContextIntoFile(
  projectRoot: string,
  env: string,
  bucketContextMap: Record<string, string>,
): Promise<void> {
  if (Object.keys(bucketContextMap).length === 0) return;
  const generatedDir = path.join(projectRoot, 'components', 'infra-cdk', 'generated', env);
  await fs.mkdir(generatedDir, { recursive: true });
  const contextPath = path.join(generatedDir, CDK_CONTEXT_FILENAME);
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(contextPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // file missing or invalid; start fresh
  }
  const merged = { ...existing, ...bucketContextMap };
  await fs.writeFile(contextPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

/** Copy generated/{env}/cdk.context.json to infra-cdk dir so CDK CLI finds it at deploy time. */
async function ensureCdkContextInAppDir(projectRoot: string, env: string): Promise<void> {
  const src = path.join(projectRoot, 'components', 'infra-cdk', 'generated', env, CDK_CONTEXT_FILENAME);
  const dest = path.join(projectRoot, 'components', 'infra-cdk', CDK_CONTEXT_FILENAME);
  try {
    await fs.copyFile(src, dest);
  } catch {
    // no generated context yet; CDK will create cdk.context.json in app dir if needed
  }
}

/** After deploy, copy cdk.context.json from app dir back to generated/{env}/ so CDK lookup cache is preserved. */
async function persistCdkContextToGenerated(projectRoot: string, env: string): Promise<void> {
  const src = path.join(projectRoot, 'components', 'infra-cdk', CDK_CONTEXT_FILENAME);
  const dest = path.join(projectRoot, 'components', 'infra-cdk', 'generated', env, CDK_CONTEXT_FILENAME);
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  } catch {
    // ignore if source missing or copy failed
  }
}

// @intent Write new OIDC deploy-role ARN into project/config.json after bootstrap/apply
async function persistGithubOidcOutputs(projectRoot: string, env: string): Promise<void> {
  const outputsPath = path.join(
    projectRoot,
    'components',
    'infra-cdk',
    'generated',
    env,
    'cdk.out',
    'cdk-outputs.json',
  );
  let outputs: Record<string, Record<string, string>>;
  try {
    outputs = JSON.parse(await fs.readFile(outputsPath, 'utf8')) as Record<string, Record<string, string>>;
  } catch {
    return;
  }
  let deployRoleArn: string | undefined;
  let providerArn: string | undefined;
  for (const stackOutputs of Object.values(outputs)) {
    if (stackOutputs.DeployRoleArn) deployRoleArn = stackOutputs.DeployRoleArn;
    if (stackOutputs.GithubOidcProviderArn) providerArn = stackOutputs.GithubOidcProviderArn;
  }
  if (!deployRoleArn && !providerArn) {
    return;
  }
  const configPath = path.join(projectRoot, 'project', 'config.json');
  let parsed: Record<string, Record<string, string>>;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, Record<string, string>>;
  } catch {
    logInfo(`[cdk] OIDC outputs present but ${configPath} could not be read; commit DeployRoleArn manually`);
    return;
  }
  const block = { ...(parsed[env] ?? {}) };
  if (deployRoleArn && block.INFRA_CDK_DEPLOY_ROLE_ARN !== deployRoleArn) {
    block.INFRA_CDK_DEPLOY_ROLE_ARN = deployRoleArn;
    logInfo(`[cdk] Updated project/config.json ${env}.INFRA_CDK_DEPLOY_ROLE_ARN=${deployRoleArn}`);
  }
  if (providerArn && block.INFRA_CDK_OIDC_PROVIDER_ARN !== providerArn) {
    block.INFRA_CDK_OIDC_PROVIDER_ARN = providerArn;
    logInfo(`[cdk] Updated project/config.json ${env}.INFRA_CDK_OIDC_PROVIDER_ARN=${providerArn}`);
  }
  parsed[env] = block;
  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

async function runCdkCommand(
  command: 'deploy' | 'destroy',
  projectRoot: string,
  appPath: string,
  env: string,
  extraArgs: string[],
  deployStackNames?: string[],
): Promise<void> {
  const componentRoot = path.join(projectRoot, 'components', 'infra-cdk');
  const outDir = path.join(projectRoot, 'components', 'infra-cdk', 'generated', env, 'cdk.out');
  await fs.mkdir(outDir, { recursive: true });

  // @intent Quote --app value for Windows shell so "node <path>" is one argument; use forward slashes for portability
  const appPathForCdk = appPath.replace(/\\/g, '/');
  const appArg = process.platform === 'win32' ? `"node ${appPathForCdk}"` : `node ${appPathForCdk}`;
  // Pass project root as context so ArtifactStack resolves dist/ paths using the invoker's path (CDK subprocess cwd differs)
  const projectRootForContext = path.resolve(projectRoot).replace(/\\/g, '/');
  const stackTarget = deployStackNames?.length ? deployStackNames : ['--all'];
  const args = [
    command,
    ...stackTarget,
    '--app',
    appArg,
    '--context',
    `ThonnasProjectRoot=${projectRootForContext}`,
    '--outputs-file',
    path.join(outDir, 'cdk-outputs.json'),
    '--output',
    outDir,
    ...extraArgs.filter((a) => a !== '--all'),
  ];
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

  logInfo(
    deployStackNames?.length
      ? `[cdk] Running aws-cdk ${command} for env "${env}" (stacks: ${deployStackNames.join(', ')})`
      : `[cdk] Running aws-cdk ${command} for env "${env}"`,
  );

  await new Promise<void>((resolve, reject) => {
    const spawnOpts: Parameters<typeof spawn>[2] = {
      cwd: componentRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        CDK_OUTDIR: outDir,
        THONNAS_PROJECT_ROOT: projectRootForContext,
      },
    };
    // On Windows, run in shell so --app "node path" and paths with backslashes work
    if (process.platform === 'win32') {
      spawnOpts.shell = true;
    }
    const child = spawn(npxCmd, ['aws-cdk', ...args], spawnOpts);

    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`aws-cdk ${command} exited with code ${code}`));
      }
    });
  });
}

/**
 * Regions that need CDK bootstrap for this deploy/destroy.
 * - Default region (from options/env) is always used.
 * - us-east-1 is required when any artifact is a static site with a custom domain, because
 *   CloudFront only accepts ACM certificates from us-east-1 (AWS limitation).
 * Bootstrap is per-region; using two regions (e.g. us-east-2 + us-east-1) works: each has its own
 * assets bucket and roles.
 */
function getRequiredBootstrapRegions(
  defaultRegion: string | undefined,
  resources: PlannedResource[] | undefined,
): Set<string> {
  const regions = new Set<string>();
  if (defaultRegion) regions.add(defaultRegion);
  if (
    resources?.some(
      (r) =>
        (r.kind === 's3StaticSiteDeployment' && (r.props?.website_domain as string | undefined)) ||
        (r.kind === 'storageTempUrlApi' && (r.props?.api_domain as string | undefined)),
    )
  ) {
    regions.add('us-east-1');
  }
  return regions;
}

async function ensureBootstrapIfPossible(
  options: SharedInfraOptions,
  projectRoot: string,
  resources?: PlannedResource[],
): Promise<void> {
  const target = await resolveAwsTarget(options);
  if (!target.accountId) {
    logInfo(
      '[cdk] Skipping bootstrap check (missing account ID). Provide --account-id or configure credentials.',
    );
    return;
  }
  logInfo(`[cdk] Target AWS account: ${target.accountId} (region: ${target.region ?? 'unset'})`);

  const regions = getRequiredBootstrapRegions(target.region, resources);
  if (regions.size === 0) {
    logInfo(
      '[cdk] Skipping bootstrap check (no region). Provide --region or set AWS_REGION/CDK_DEFAULT_REGION.',
    );
    return;
  }

  for (const region of regions) {
    const alreadyBootstrapped = await isBootstrapped(target.accountId, region).catch((error) => {
      if (error instanceof BootstrapPermissionError) {
        throw new Error(
          `${error.message} These permissions are required to auto-bootstrap: ssm:GetParameter, cloudformation:CreateStack, iam:PassRole, s3:CreateBucket.`,
        );
      }
      throw error;
    });

    if (alreadyBootstrapped) {
      continue;
    }

    logInfo(
      `[cdk] Bootstrap stack not found for aws://${target.accountId}/${region}. Running 'cdk bootstrap'...`,
    );
    await runCdkBootstrap(projectRoot, target.accountId, region);
    markBootstrapped(target.accountId, region);
  }
}

async function runCdkBootstrap(projectRoot: string, accountId: string, region: string): Promise<void> {
  const componentRoot = path.resolve(projectRoot, 'components', 'infra-cdk');
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['aws-cdk', 'bootstrap', `aws://${accountId}/${region}`];

  const spawnOpts: Parameters<typeof spawn>[2] = {
    cwd: componentRoot,
    stdio: 'inherit',
  };
  // @intent On Windows, spawn(npx.cmd, args) can yield EINVAL; use shell so the command runs correctly
  if (process.platform === 'win32') {
    spawnOpts.shell = true;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(npxCmd, args, spawnOpts);

    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `cdk bootstrap exited with code ${code}. Ensure the AWS credentials allow ssm:GetParameter/PutParameter, cloudformation:CreateStack, iam:PassRole, and s3:CreateBucket.`,
          ),
        );
      }
    });
  });
}

async function resolveAwsTarget(
  options: SharedInfraOptions,
): Promise<{ accountId?: string; region?: string }> {
  let region =
    options.region ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    process.env.CDK_DEFAULT_REGION;

  if (!region) {
    region = await resolveRegionFromConfig();
  }

  let accountId = options.accountId;

  if (!accountId) {
    try {
      const stsClient = region ? new STSClient({ region }) : new STSClient({});
      const identity = await stsClient.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account ?? undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[cdk] Unable to determine AWS account via STS (run with --account-id to skip): ${message}`,
      );
    }
  }

  return { accountId, region };
}

const resolveRegionFromConfig = async (): Promise<string | undefined> => {
  try {
    const profile = process.env.AWS_PROFILE ?? process.env.AWS_DEFAULT_PROFILE ?? 'default';
    const { configFile } = await loadSharedConfigFiles();
    const section = configFile[profile];
    return section?.region;
  } catch {
    return undefined;
  }
};

function printPlanSummary(
  env: string,
  result: Awaited<ReturnType<typeof planInfrastructure>>,
  planContextMap?: Record<string, string>,
): void {
  const summary = result.resolvedIntents.map((intent) => ({
    component: intent.component,
    domain: intent.domain,
    strategies: Object.keys(intent.strategies).length,
  }));

  logSuccess(`Infrastructure plan generated for env "${env}"`);
  logInfo(`• Components found: ${summary.length}`);
  summary.forEach((intent) => {
    logInfo(`  - ${intent.component} → ${intent.domain} (${intent.strategies} strategies)`);
  });
  logInfo(`• Secrets ensured: ${result.secrets.length}`);
  if (result.strategyResolution.components.length) {
    logInfo(`• Planned runtime constructs: ${result.strategyResolution.components.length}`);
  }
  logInfo(`• Planned resources: ${result.strategyResolution.resources.length}`);
  if (result.artifactUploads.length > 0) {
    logInfo(`• Artifacts to upload (apply): ${result.artifactUploads.length} component(s)`);
    result.artifactUploads.forEach((entry) => {
      logInfo(`  - ${entry.component} (version ${entry.version}): ${entry.paths.length} file(s)`);
      entry.paths.forEach((p) => logInfo(`    ${p}`));
    });
  }
  const missingARecords =
    planContextMap &&
    Object.entries(planContextMap).filter(([k, v]) => k.startsWith('ThonnasARecordExists:') && v === 'false');
  if (missingARecords && missingARecords.length > 0) {
    logInfo(`• Static site(s) missing Route53 A record: ${missingARecords.length} (run apply to create)`);
  }
  logInfo(
    `• Dependency graph: ${result.dependencyGraph.nodes.length} nodes / ${result.dependencyGraph.edges.length} edges`,
  );
  logInfo(`• Debug output: ${result.outputPath}`);
  logInfo(`• Graph output: ${result.graphOutputPath}`);
  logInfo(`• CDK app: ${result.cdkAppPath}`);
  if (result.stackRows.length) {
    logInfo('• Stack status:');
    formatPlanSummaryLines(result.stackRows).forEach((line) => logInfo(`  ${line}`));
  }
}

// @intent HeadBucket before classify so artifact rows can be import
function headBucketExistsMap(
  region: string | undefined,
  env: string,
): ((bucketNames: string[]) => Promise<Record<string, boolean>>) | undefined {
  if (!region) return undefined;
  return async (bucketNames) => {
    const { bucketContextMap } = await resolveBucketExistsContext(
      bucketNames.map((bucketName) => ({
        id: `head-${bucketName}`,
        kind: 's3ArtifactDeployment',
        component: 'plan-head',
        env,
        scope: 'service',
        props: { bucket: bucketName },
      })),
      region,
    );
    const found: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(bucketContextMap)) {
      if (key.startsWith('ThonnasBucketExists:') && value === 'true') {
        found[key.slice('ThonnasBucketExists:'.length)] = true;
      }
    }
    return found;
  };
}

// @intent Load CFN names + cert status for plan; cheap tests inject this instead
async function resolvePlanExistingState(
  region?: string,
  rootDomain?: string,
): Promise<InjectedAwsState> {
  const existingStackNames = region ? await listCfnStackNames(region) : [];
  const envWould = process.env.THONNAS_PLAN_WOULD_CHANGE?.trim();
  let wouldChange: boolean | undefined;
  if (envWould === 'true') wouldChange = true;
  if (envWould === 'false') wouldChange = false;

  // @intent An explicitly-supplied ARN always wins (manual override, or a value an operator
  // already knows is ISSUED) -- no ACM lookup needed.
  const explicitCertArn = process.env.THONNAS_ALB_CERTIFICATE_ARN?.trim();
  const explicitPending = process.env.THONNAS_CERT_STATUS?.trim();
  if (explicitCertArn) {
    return { existingStackNames, certStatus: 'issued', wouldChange };
  }
  if (explicitPending === 'pending' || explicitPending === 'missing' || explicitPending === 'issued') {
    return { existingStackNames, certStatus: explicitPending, wouldChange };
  }

  // @intent Discover (or notice a just-requested, still-validating) wildcard ALB cert the same
  // way the storage-temp-url/static-site flows already do for their own per-domain certs --
  // never a stub. A real wildcard cert here (*.{rootDomain}) covers every ALB-fronted ECS HTTP
  // service's hyphenated domain ({env}-{component}.{rootDomain}) without needing one cert per
  // component. Skipped entirely when there's no region/rootDomain to look anything up with --
  // callers that never need the ALB (no region) fall through to 'missing' exactly as before.
  if (region && rootDomain) {
    const albCertStatus = await resolveAlbWildcardCertStatus(region, rootDomain);
    if (albCertStatus) {
      if (albCertStatus.arn) process.env.THONNAS_ALB_CERTIFICATE_ARN = albCertStatus.arn;
      return { existingStackNames, certStatus: albCertStatus.status, wouldChange };
    }
  }
  return { existingStackNames, certStatus: 'missing', wouldChange };
}

/** @intent ACM certs for an ALB live in the ALB's own region (unlike CloudFront, which requires us-east-1). */
async function resolveAlbWildcardCertStatus(
  region: string,
  rootDomain: string,
): Promise<{ status: PlanCertStatus; arn?: string } | undefined> {
  const wildcardDomain = `*.${rootDomain.replace(/\.$/, '')}`;
  try {
    const acmClient = new ACMClient({ region });
    const [issuedList, pendingList] = await Promise.all([
      acmClient.send(new ListCertificatesCommand({ CertificateStatuses: ['ISSUED'] })),
      acmClient.send(new ListCertificatesCommand({ CertificateStatuses: ['PENDING_VALIDATION'] })),
    ]);
    const issuedCert = issuedList.CertificateSummaryList?.find((c: CertificateSummary) => c.DomainName === wildcardDomain);
    if (issuedCert?.CertificateArn) {
      logInfo(`[cdk] ACM wildcard cert already exists (ISSUED) for ${wildcardDomain}, will reuse`);
      return { status: 'issued', arn: issuedCert.CertificateArn };
    }
    const pendingCert = pendingList.CertificateSummaryList?.find((c: CertificateSummary) => c.DomainName === wildcardDomain);
    if (pendingCert?.CertificateArn) {
      logInfo(
        `[cdk] ACM wildcard cert for ${wildcardDomain} is still validating (DNS record auto-created by the ` +
          `prior apply) -- re-run infra apply once ACM shows it ISSUED, typically a few minutes.`,
      );
      return { status: 'pending', arn: pendingCert.CertificateArn };
    }
    return { status: 'missing' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logInfo(`[cdk] ACM list certs for ${wildcardDomain}: ${msg}`);
    return undefined;
  }
}

async function listCfnStackNames(region: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'aws',
      [
        'cloudformation',
        'list-stacks',
        '--region',
        region,
        '--stack-status-filter',
        'CREATE_COMPLETE',
        'UPDATE_COMPLETE',
        'UPDATE_ROLLBACK_COMPLETE',
        '--query',
        'StackSummaries[].StackName',
        '--output',
        'json',
      ],
      { timeout: 30000 },
    );
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function logInfo(message: string): void {
  console.log(message);
}

function logSuccess(message: string): void {
  console.log(`✅ ${message}`);
}

function logError(message: string): void {
  console.error(`❌ ${message}`);
}



