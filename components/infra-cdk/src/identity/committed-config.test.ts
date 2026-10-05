import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from '@jest/globals';
import { loadCommittedExportDefaults, resolveExportDefault } from './committed-config';

describe('committed-config', () => {
  it('resolves defaultByEnv for the active env and treats empty as unset', () => {
    expect(
      resolveExportDefault(
        { name: 'INFRA_CDK_DEPLOY_ROLE_ARN', defaultByEnv: { development: '', beta: 'arn:aws:iam::1:role/beta' } },
        'beta',
      ),
    ).toBe('arn:aws:iam::1:role/beta');
    expect(
      resolveExportDefault(
        { name: 'INFRA_CDK_DEPLOY_ROLE_ARN', defaultByEnv: { development: '', beta: 'arn:aws:iam::1:role/beta' } },
        'development',
      ),
    ).toBeUndefined();
  });

  it('loads committed exports from thonnas-config.json without calling AWS', () => {
    const dir = path.join(os.tmpdir(), `infra-cdk-config-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'thonnas-config.json'),
      JSON.stringify({
        exports: [
          {
            name: 'INFRA_CDK_DEPLOY_ROLE_ARN',
            defaultByEnv: { beta: 'arn:aws:iam::9:role/committed' },
          },
          { name: 'AWS_REGION', default: 'us-east-1' },
        ],
      }),
    );
    try {
      const defaults = loadCommittedExportDefaults(dir, 'beta');
      expect(defaults.INFRA_CDK_DEPLOY_ROLE_ARN).toBe('arn:aws:iam::9:role/committed');
      expect(defaults.AWS_REGION).toBe('us-east-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overlays project/config.json so empty package defaults still yield a role ARN', () => {
    const dir = path.join(os.tmpdir(), `infra-cdk-config-project-${Date.now()}`);
    const projectRoot = path.join(dir, 'project-root');
    mkdirSync(path.join(projectRoot, 'project'), { recursive: true });
    mkdirSync(path.join(dir, 'component'), { recursive: true });
    writeFileSync(
      path.join(dir, 'component', 'thonnas-config.json'),
      JSON.stringify({
        exports: [
          {
            name: 'INFRA_CDK_DEPLOY_ROLE_ARN',
            defaultByEnv: { development: '', beta: '' },
          },
        ],
      }),
    );
    writeFileSync(
      path.join(projectRoot, 'project', 'config.json'),
      JSON.stringify({
        beta: { INFRA_CDK_DEPLOY_ROLE_ARN: 'arn:aws:iam::1:role/from-project' },
      }),
    );
    try {
      const defaults = loadCommittedExportDefaults(path.join(dir, 'component'), 'beta', projectRoot);
      expect(defaults.INFRA_CDK_DEPLOY_ROLE_ARN).toBe('arn:aws:iam::1:role/from-project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

