import { describe, expect, it } from '@jest/globals';
import { ResolvedCloudComponent } from '../types';
import { listPlannedStacks, PlanStackRow, selectTargetStackIds } from './stack-status';

const composeHost = (component: string): ResolvedCloudComponent => ({
  id: `beta-${component}`,
  component,
  env: 'beta',
  strategy: 'runtime',
  construct: 'ComposeHostEc2',
  scope: 'service',
  requires: [],
  metadata: {},
});

describe('selectTargetStackIds', () => {
  it('matches a shared ComposeHost stack for every component folded into it', () => {
    const planned = listPlannedStacks({ components: [composeHost('web-a'), composeHost('web-b')], resources: [] }, 'beta');
    const composeRow = planned.find((row) => row.family === 'compose-host');
    expect(composeRow?.components).toEqual(['web-a', 'web-b']);
    const rows: PlanStackRow[] = planned.map((ref) => ({
      stackId: ref.stackId,
      family: ref.family,
      status: 'create',
      components: ref.components,
    }));
    expect(selectTargetStackIds(rows, ['web-b'], 'deploy')).toEqual(
      expect.arrayContaining([composeRow!.stackId]),
    );
  });

  it('ignores shared stacks and refuses a target that owns none', () => {
    const rows: PlanStackRow[] = [
      { stackId: 'StagingNetworking', family: 'networking', status: 'create' },
      { stackId: 'StagingWiring', family: 'wiring', status: 'create' },
      { stackId: 'Stagingapi-webService', family: 'ecs', status: 'create', components: ['api-web'] },
    ];
    expect(() => selectTargetStackIds(rows, ['api-web', 'worker'], 'destroy')).toThrow(
      /--target-component worker produced no destroyable stacks; refusing to run cdk destroy/,
    );
    expect(selectTargetStackIds(rows, ['api-web'], 'destroy')).toEqual(['Stagingapi-webService']);
  });

  it('attributes the shared EdgeNlb stack to the component(s) needing mqtt/ws/tcp so --target-component can deploy it', () => {
    const mqttComponent: ResolvedCloudComponent = {
      id: 'staging-queue-mqtt',
      component: 'queue-mqtt',
      env: 'staging',
      strategy: 'runtime',
      construct: 'ECSFargateService',
      scope: 'service',
      requires: [],
      metadata: { runtimeType: 'ecs-fargate', protocols: ['mqtt'] },
    };
    const planned = listPlannedStacks({ components: [mqttComponent], resources: [] }, 'staging');
    const nlbRow = planned.find((row) => row.family === 'nlb');
    expect(nlbRow?.components).toEqual(['queue-mqtt']);

    const rows: PlanStackRow[] = planned.map((ref) => ({
      stackId: ref.stackId,
      family: ref.family,
      status: 'create',
      components: ref.components,
    }));
    expect(selectTargetStackIds(rows, ['queue-mqtt'], 'deploy')).toContain(nlbRow!.stackId);
  });

  it('always includes ownerless foundational stacks (networking, wiring) on deploy, but never on destroy', () => {
    const rows: PlanStackRow[] = [
      { stackId: 'StagingNetworking', family: 'networking', status: 'create' },
      { stackId: 'StagingWiring', family: 'wiring', status: 'create' },
      { stackId: 'Stagingapi-webService', family: 'ecs', status: 'create', components: ['api-web'] },
    ];
    expect(selectTargetStackIds(rows, ['api-web'], 'deploy')).toEqual(
      expect.arrayContaining(['StagingNetworking', 'StagingWiring', 'Stagingapi-webService']),
    );
    expect(selectTargetStackIds(rows, ['api-web'], 'destroy')).toEqual(['Stagingapi-webService']);
  });

  it('attributes the TemporalToEcs edge to the temporal component so --target-component can deploy it', () => {
    const temporalComponent: ResolvedCloudComponent = {
      id: 'staging-worker-manager-temporal-worker',
      component: 'worker-manager-temporal',
      env: 'staging',
      strategy: 'worker',
      construct: 'TemporalServer',
      scope: 'service',
      requires: [],
      metadata: { extras: {} },
    };
    const planned = listPlannedStacks({ components: [temporalComponent], resources: [] }, 'staging');
    const edgeRow = planned.find((row) => row.family === 'temporal-to-ecs');
    expect(edgeRow?.components).toEqual(['worker-manager-temporal']);

    const rows: PlanStackRow[] = planned.map((ref) => ({
      stackId: ref.stackId,
      family: ref.family,
      status: 'create',
      components: ref.components,
    }));
    expect(selectTargetStackIds(rows, ['worker-manager-temporal'], 'deploy')).toContain(edgeRow!.stackId);
  });

  it('attributes the shared EventsBus stack to its owning component', () => {
    const planned = listPlannedStacks(
      {
        components: [],
        resources: [
          {
            id: 'staging-events-bus',
            kind: 'snsSqsEventBus',
            env: 'staging',
            scope: 'service',
            component: 'tm-ecommerce',
            props: {},
          },
        ],
      },
      'staging',
    );
    const eventsBusRow = planned.find((row) => row.family === 'events-bus');
    expect(eventsBusRow?.components).toEqual(['tm-ecommerce']);

    const rows: PlanStackRow[] = planned.map((ref) => ({
      stackId: ref.stackId,
      family: ref.family,
      status: 'create',
      components: ref.components,
    }));
    expect(selectTargetStackIds(rows, ['tm-ecommerce'], 'deploy')).toContain(eventsBusRow!.stackId);
  });
});

