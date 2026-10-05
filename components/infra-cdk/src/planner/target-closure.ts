// @intent Expand --target-component to the components whose stacks its own stacks consume

import { DeploymentIntent, ResolvedCloudComponent, StrategyResolutionResult } from '../types';

// Data-plane constructs whose *ToEcs edge stacks mutate every Fargate peer's task definition
// (secrets, grants), so an ECS target synthesized without them would drop that wiring.
const ECS_PEER_PROVIDERS = ['RdsPostgresInstance', 'AwsDocumentDbCluster', 'ElasticacheRedisCluster', 'MqttFleet'];

// @intent Map a resolved component to the constructs runtime.ts wires into its stacks
const consumedConstructs = (component: ResolvedCloudComponent): string[] => {
  // TemporalStack is only emitted when an RDS stack exists (rdsStacks[0] in runtime.ts)
  if (component.construct === 'TemporalServer') return ['RdsPostgresInstance'];
  // Dashboard metastore (RelationalToObserve) + DbaFleet peer edges
  if (component.construct === 'ObserveIngest') return ['RdsPostgresInstance', 'DbaFleet'];
  // One shared ComposeHost stack renders every compose-host component's services
  if (component.construct === 'ComposeHostEc2') return ['ComposeHostEc2'];
  if (component.construct === 'ECSFargateService' || component.metadata.runtimeType === 'ecs-fargate') {
    return ECS_PEER_PROVIDERS;
  }
  return [];
};

// @intent Walk construct dependencies to a fixed point starting from the target components
export function resolveTargetClosure(resolution: StrategyResolutionResult, targets: string[]): Set<string> {
  const closure = new Set(targets);
  const services = resolution.components.filter((c) => c.scope === 'service');
  let changed = true;
  while (changed) {
    changed = false;
    const wanted = new Set(
      services.filter((c) => closure.has(c.component)).flatMap((c) => consumedConstructs(c)),
    );
    for (const provider of services) {
      if (wanted.has(provider.construct) && !closure.has(provider.component)) {
        closure.add(provider.component);
        changed = true;
      }
    }
  }
  return closure;
}

// Installed libs (.thonnas/libs/*) declare project-wide strategies; --target-component never drops them
const isLibIntent = (intent: DeploymentIntent): boolean =>
  intent.componentPath.replace(/\\/g, '/').startsWith('.thonnas/libs/');

// @intent Keep targets, their consumed providers, and libs; drop every other app package
export function selectTargetIntents(
  intents: DeploymentIntent[],
  resolution: StrategyResolutionResult,
  targets: string[],
): DeploymentIntent[] {
  const closure = resolveTargetClosure(resolution, targets);
  return intents.filter((intent) => closure.has(intent.component) || isLibIntent(intent));
}

