import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';

const mockIntents: Array<{ component: string; componentPath: string }> = [];

jest.mock('../planner/collector/deployment-intents', () => ({
  collectDeploymentIntents: jest.fn(async () => mockIntents),
}));

describe('resolveReleaseJobs', () => {
  it('routes a lib-sourced intent (componentPath under .thonnas/libs/) through --lib, not --target-component', async () => {
    mockIntents.length = 0;
    mockIntents.push(
      { component: 'api-go', componentPath: path.join('components', 'api-go') },
      { component: 'cicd-github-actions', componentPath: path.join('.thonnas', 'libs', 'cicd-github-actions') },
    );
    const { resolveReleaseJobs } = await import('./resolve-release-jobs');
    const jobs = await resolveReleaseJobs('/fake/root', 'staging', {});
    expect(jobs).toEqual([
      { targetComponent: 'api-go' },
      { lib: 'cicd-github-actions' },
    ]);
  });

  it('still returns plain --target-component jobs when every intent is a real component', async () => {
    mockIntents.length = 0;
    mockIntents.push(
      { component: 'api-go', componentPath: path.join('components', 'api-go') },
      { component: 'dbt-postgres', componentPath: path.join('components', 'dbt-postgres') },
    );
    const { resolveReleaseJobs } = await import('./resolve-release-jobs');
    const jobs = await resolveReleaseJobs('/fake/root', 'staging', {});
    expect(jobs).toEqual([{ targetComponent: 'api-go' }, { targetComponent: 'dbt-postgres' }]);
  });

  it('passes through an explicit --target-component without consulting collectDeploymentIntents', async () => {
    mockIntents.length = 0;
    const { resolveReleaseJobs } = await import('./resolve-release-jobs');
    const jobs = await resolveReleaseJobs('/fake/root', 'staging', { targetComponent: 'api-go' });
    expect(jobs).toEqual([{ targetComponent: 'api-go' }]);
  });
});

