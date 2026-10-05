import { describe, expect, it } from '@jest/globals';
import { existingOacPolicyCoversImport, staleOacPolicyAction } from './static-site-oac';

const distArn = 'arn:aws:cloudfront::123456789012:distribution/ENEW';
const policyFor = (arn: string) =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Sid: 'AllowCloudFrontOAC', Effect: 'Allow', Condition: { StringEquals: { 'AWS:SourceArn': arn } } }],
  });

describe('existingOacPolicyCoversImport', () => {
  it('skips only an unowned policy that grants the imported distribution', () => {
    expect(
      existingOacPolicyCoversImport({ policyJson: policyFor(distArn), policyOwner: null, importedDistributionArn: distArn }),
    ).toBe(true);
  });

  it('keeps a stack-owned policy in the template', () => {
    expect(
      existingOacPolicyCoversImport({
        policyJson: policyFor(distArn),
        policyOwner: 'Stagingweb-angularStaticSite',
        importedDistributionArn: distArn,
      }),
    ).toBe(false);
  });

  it('manages the policy when ownership is unknown', () => {
    expect(
      existingOacPolicyCoversImport({ policyJson: policyFor(distArn), policyOwner: undefined, importedDistributionArn: distArn }),
    ).toBe(false);
  });

  it('rewrites a stale policy that names a different (deleted) distribution', () => {
    expect(
      existingOacPolicyCoversImport({
        policyJson: policyFor('arn:aws:cloudfront::123456789012:distribution/EOLD'),
        policyOwner: null,
        importedDistributionArn: distArn,
      }),
    ).toBe(false);
  });

  it('manages the policy when StaticSite creates its own distribution', () => {
    expect(existingOacPolicyCoversImport({ policyJson: policyFor(distArn), policyOwner: null })).toBe(false);
  });
});

describe('staleOacPolicyAction', () => {
  const oacOnly = policyFor('arn:aws:cloudfront::123456789012:distribution/EOLD');
  const mixed = JSON.stringify({
    Statement: [{ Sid: 'AllowCloudFrontOAC' }, { Sid: 'SomethingElse', Effect: 'Deny' }],
  });

  it('deletes an unowned policy that only holds our stale OAC statement', () => {
    expect(staleOacPolicyAction({ policyJson: oacOnly, policyOwner: null, stackSkipsPolicy: false })).toBe('delete');
  });

  it('refuses to touch an unowned policy with foreign statements', () => {
    expect(staleOacPolicyAction({ policyJson: mixed, policyOwner: null, stackSkipsPolicy: false })).toBe('conflict');
  });

  it('leaves stack-owned, unknown-owner, and kept policies alone', () => {
    expect(staleOacPolicyAction({ policyJson: oacOnly, policyOwner: 'Stagingweb-angularStaticSite', stackSkipsPolicy: false })).toBe('none');
    expect(staleOacPolicyAction({ policyJson: oacOnly, policyOwner: undefined, stackSkipsPolicy: false })).toBe('none');
    expect(staleOacPolicyAction({ policyJson: oacOnly, policyOwner: null, stackSkipsPolicy: true })).toBe('none');
  });
});

