import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
} from '@aws-sdk/client-ecs';
import type { ReleasedContainer } from '../stacks/released-container';
import { isReleasedContainerImage } from '../stacks/released-container';
import { wiringClusterName } from './ecs-fargate';

export async function loadReleasedFargateContainers(input: {
  region: string;
  env: string;
  projectName?: string;
  components: string[];
}): Promise<Record<string, ReleasedContainer>> {
  const cluster = wiringClusterName(input.env, input.projectName);
  const ecs = new ECSClient({ region: input.region });
  const out: Record<string, ReleasedContainer> = {};
  for (const component of input.components) {
    const service = `${input.env}-${component}`;
    try {
      const described = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
      const taskArn = described.services?.[0]?.taskDefinition;
      if (!taskArn) continue;
      const task = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskArn }));
      const container = task.taskDefinition?.containerDefinitions?.[0];
      const image = container?.image?.trim() ?? '';
      if (!isReleasedContainerImage(image)) continue;
      out[component] = {
        image,
        environment: (container?.environment ?? [])
          .filter((entry): entry is { name: string; value: string } => Boolean(entry.name))
          .map((entry) => ({ name: entry.name, value: entry.value ?? '' })),
        secrets: (container?.secrets ?? [])
          .filter((entry): entry is { name: string; valueFrom: string } => Boolean(entry.name && entry.valueFrom))
          .map((entry) => ({ name: entry.name, valueFrom: entry.valueFrom })),
      };
    } catch {
      // @intent Missing service on first apply is not an error
    }
  }
  return out;
}



