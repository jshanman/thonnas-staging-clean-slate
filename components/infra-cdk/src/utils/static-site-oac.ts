// @intent Decide whether StaticSite may omit its own OAC bucket policy (ThonnasBucketPolicyHasOAC)

type PolicyStatement = { Sid?: string; Condition?: Record<string, Record<string, unknown>> };

const sourceArnsOf = (statement: PolicyStatement): string[] => {
  const out: string[] = [];
  for (const operator of Object.values(statement.Condition ?? {})) {
    for (const [key, value] of Object.entries(operator ?? {})) {
      if (key.toLowerCase() !== 'aws:sourcearn') continue;
      for (const v of Array.isArray(value) ? value : [value]) if (typeof v === 'string') out.push(v);
    }
  }
  return out;
};

const statementsOf = (policyJson: string): PolicyStatement[] | undefined => {
  try {
    const parsed = JSON.parse(policyJson) as { Statement?: PolicyStatement[] | PolicyStatement };
    return Array.isArray(parsed.Statement) ? parsed.Statement : parsed.Statement ? [parsed.Statement] : [];
  } catch {
    return undefined;
  }
};

/**
 * @intent Before StaticSite creates its OAC policy, clear a stale one it cannot adopt.
 * CloudFormation refuses to create AWS::S3::BucketPolicy when the bucket already has a policy,
 * so an unowned policy left by an earlier apply (whose only statement is our own
 * AllowCloudFrontOAC) is deleted; an unowned policy with anything else in it is a conflict we
 * must not touch. Stack-owned or unknown-owner policies are left for CloudFormation to update.
 */
export function staleOacPolicyAction(input: {
  policyJson?: string;
  policyOwner: string | null | undefined;
  /** ThonnasBucketPolicyHasOAC resolved true: the existing policy is kept and the stack skips its own. */
  stackSkipsPolicy: boolean;
}): 'none' | 'delete' | 'conflict' {
  if (input.stackSkipsPolicy || !input.policyJson || input.policyOwner !== null) return 'none';
  const statements = statementsOf(input.policyJson);
  if (!statements || statements.length === 0) return 'conflict';
  return statements.every((s) => s.Sid === 'AllowCloudFrontOAC') ? 'delete' : 'conflict';
}

/**
 * @intent Skip the stack's policy ONLY when a policy no stack owns already grants the exact
 * distribution StaticSite will import. A stack-owned policy must stay in its template (omitting
 * it makes CloudFormation delete it), and a policy naming any other distribution -- e.g. one a
 * previous apply deleted -- leaves CloudFront with 403s, so the stack must write its own.
 */
export function existingOacPolicyCoversImport(input: {
  policyJson?: string;
  /** owningStackName(bucket): string = stack-owned, null = unowned, undefined = unknown. */
  policyOwner: string | null | undefined;
  /** ARN of the leftover distribution StaticSite will import; undefined when the stack creates/owns it. */
  importedDistributionArn?: string;
}): boolean {
  if (input.policyOwner !== null || !input.importedDistributionArn || !input.policyJson) return false;
  const statements = statementsOf(input.policyJson) ?? [];
  return statements.some(
    (s) => s.Sid === 'AllowCloudFrontOAC' && sourceArnsOf(s).includes(input.importedDistributionArn!),
  );
}

