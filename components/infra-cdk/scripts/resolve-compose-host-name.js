#!/usr/bin/env node
// @intent Compute the deterministic compose-host EC2 instance Name tag from project name + env,
// so callers (release-beta.sh, CI) never need to hardcode/store an instance ID — it changes every
// time `thonnas infra apply` replaces the instance (content-hash logical id), but the Name tag
// (${stackPrefix}-${component}-compose) does not, since stackPrefix only depends on project name +
// env for the default "env" compose-host scope (see src/cdk/env-profiles.ts buildEnvProfile).
// Requires `npm run build` to have already produced dist/ (same prerequisite infra:apply already has).
'use strict';

const path = require('node:path');
const { buildEnvProfile } = require('../dist/cdk/env-profiles.js');
const { resolveProjectName } = require('../dist/utils/root-domain.js');

function parseArgs(argv) {
  // @intent Default project root is the repo root (three levels up from this script:
  // components/infra-cdk/scripts -> components/infra-cdk -> components -> repo root), not cwd —
  // callers typically run this from within components/infra-cdk (same as `npm run build`).
  const out = { env: 'beta', component: 'infra-docker', projectRoot: path.resolve(__dirname, '..', '..', '..') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i];
    else if (a === '--component') out.component = argv[++i];
    else if (a === '--project-root') out.projectRoot = argv[++i];
  }
  return out;
}

async function main() {
  const { env, component, projectRoot } = parseArgs(process.argv.slice(2));
  const resolvedRoot = path.resolve(projectRoot);
  const projectName = await resolveProjectName(resolvedRoot, env);
  // @intent components: [] is safe here because the "env" compose-host scope (this project's
  // current setup — no deploy-slug-scoped stacks) is buildEnvProfile's default when no
  // compose-host components are passed in; a project using git-tag/account scope would need the
  // real component graph to compute correctly, which this lightweight resolver does not attempt.
  const profile = buildEnvProfile(env, [], undefined, projectName);
  process.stdout.write(`${profile.stackPrefix}-${component}-compose\n`);
}

main().catch((err) => {
  console.error(`resolve-compose-host-name failed: ${err.message}`);
  process.exit(1);
});

