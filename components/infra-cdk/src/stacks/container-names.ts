import type { ContainerDefinition } from 'aws-cdk-lib/aws-ecs';

const names = new WeakMap<ContainerDefinition, Set<string>>();

// @intent Track env/secret names already on a container so edges do not double-add
export function rememberContainerName(container: ContainerDefinition, name: string): void {
  let set = names.get(container);
  if (!set) {
    set = new Set();
    names.set(container, set);
  }
  set.add(name);
}

export function containerHasName(container: ContainerDefinition, name: string): boolean {
  return names.get(container)?.has(name) ?? false;
}



