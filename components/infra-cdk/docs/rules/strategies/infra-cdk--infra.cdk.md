# Strategy Implementation: infra.cdk

**Component:** infra-cdk  
**Purpose:** AWS CDK provider that turns `thonnas-infra.json` declarations into plan/apply/destroy for a Thonnas project.

## Implementation Notes
- `src/bin/infra-provider.ts` is the CLI (`plan`, `apply`, `destroy`), also invoked via `thonnas infra *`.
- `src/planner/plan.ts` runs collector → strategy resolver → dependency graph → CDK app emit into `generated/<env>/`.
- `src/cdk/app-builder.ts` and `src/cdk/runtime.ts` load that payload and instantiate stacks (networking, ECS, compose host, artifacts, storage).

## Guidelines
- Keep `generated/<env>/` JSON layouts stable; consumers depend on them.
- New resource kinds need both planner mapping and runtime stack wiring.
- New CLI flags go through `infra-provider.ts` → `planInfrastructure` and should be documented in `README.md`.

