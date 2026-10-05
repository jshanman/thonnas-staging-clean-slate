// @intent Merge injected AWS state for cheap plan; production lists CFN names

export type PlanCertStatus = 'missing' | 'pending' | 'issued';

export interface InjectedAwsState {
  existingStackNames?: string[];
  bucketExists?: Record<string, boolean>;
  certStatus?: PlanCertStatus;
  /** Per-stack or global. Existence alone must not pick update vs unchanged. */
  wouldChange?: boolean | Record<string, boolean>;
}

export interface ExistingAwsState {
  existingStackNames: Set<string>;
  bucketExists: Record<string, boolean>;
  certStatus: PlanCertStatus;
  wouldChange: (stackId: string) => boolean | undefined;
}

// @intent Build existing-state from injection only (no extras.existing)
export function resolveExistingState(injected?: InjectedAwsState): ExistingAwsState {
  const names = new Set(injected?.existingStackNames ?? []);
  const would = injected?.wouldChange;
  return {
    existingStackNames: names,
    bucketExists: { ...(injected?.bucketExists ?? {}) },
    certStatus: injected?.certStatus ?? 'missing',
    wouldChange: (stackId: string) => {
      if (would === undefined) return undefined;
      if (typeof would === 'boolean') return would;
      if (Object.prototype.hasOwnProperty.call(would, stackId)) return would[stackId];
      return undefined;
    },
  };
}

export function stackExists(state: ExistingAwsState, stackId: string): boolean {
  return state.existingStackNames.has(stackId);
}

export function bucketIsImport(state: ExistingAwsState, bucketName?: string): boolean {
  if (!bucketName) return false;
  return state.bucketExists[bucketName] === true;
}



