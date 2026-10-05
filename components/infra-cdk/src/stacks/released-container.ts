import type { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { containerHasName, rememberContainerName } from './container-names';

export type ReleasedContainer = {
  image: string;
  environment: Array<{ name: string; value: string }>;
  secrets: Array<{ name: string; valueFrom: string }>;
};

// @intent Pause image means apply still owns first boot; do not treat it as a release
export function isReleasedContainerImage(image?: string): boolean {
  if (!image?.trim()) return false;
  return !(/\/pause(?::|@|$)/i.test(image) || image.includes('kubernetes/pause'));
}

// @intent Rebuild a Secrets Manager / SSM secret reference from a live valueFrom ARN
export function secretFromValueFrom(scope: Construct, id: string, valueFrom: string): ecs.Secret {
  const ssm = valueFrom.match(/^(arn:aws:ssm:[^:]+:[^:]+:parameter\/.+)$/);
  if (ssm) {
    return ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterArn(scope, id, ssm[1]));
  }
  const withField = valueFrom.match(/^(arn:aws:secretsmanager:.+):([^:]+)::$/);
  if (withField) {
    return ecs.Secret.fromSecretsManager(Secret.fromSecretCompleteArn(scope, id, withField[1]), withField[2]);
  }
  if (valueFrom.startsWith('arn:aws:secretsmanager:')) {
    return ecs.Secret.fromSecretsManager(Secret.fromSecretCompleteArn(scope, id, valueFrom));
  }
  throw new Error(`Unsupported ECS secret valueFrom "${valueFrom}"`);
}

// @intent Keep a released image's env/secrets when apply re-synthesizes the service stack.
// taskDefinition is required (not optional) specifically so every re-attached secret can also
// grant its execution role read access -- omitting the grant was a real bug: the attached
// ecs.Secret reference alone is not enough for ECS to actually pull the value at task launch.
// A stack that only ever fell back to the FARGATE_PAUSE_IMAGE (never released) would never have
// surfaced this, since applyReleasedContainer no-ops when `released` is unset -- it only showed up
// on a genuine release-then-reapply cycle, where the previously-granted role can be gone (e.g. a
// torn-down/recreated env) even though the secret reference itself was faithfully replayed.
export function applyReleasedContainer(
  scope: Construct,
  container: ecs.ContainerDefinition,
  taskDefinition: ecs.TaskDefinition,
  released?: ReleasedContainer,
): void {
  if (!released || !isReleasedContainerImage(released.image)) return;
  for (const entry of released.environment) {
    if (!entry.name || containerHasName(container, entry.name)) continue;
    container.addEnvironment(entry.name, entry.value ?? '');
    rememberContainerName(container, entry.name);
  }
  released.secrets.forEach((entry, index) => {
    if (!entry.name || !entry.valueFrom || containerHasName(container, entry.name)) return;
    const secret = secretFromValueFrom(scope, `ReleasedSecret${index}`, entry.valueFrom);
    container.addSecret(entry.name, secret);
    rememberContainerName(container, entry.name);
    secret.grantRead(taskDefinition.obtainExecutionRole());
  });
}



