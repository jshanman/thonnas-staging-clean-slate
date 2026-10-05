// @intent Prepare artifact bucket and release write policy; never upload app files
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { PlannedResource, ResolvedCloudComponent } from '../types';

export interface ArtifactStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  /** Planned resources (s3WebsiteBucket, route53AliasForS3, s3ArtifactDeployment) */
  resources: PlannedResource[];
  /** Project root for resolving artifact path templates (aligns with CLI --project-root and THONNAS_PROJECT_ROOT) */
  projectRoot: string;
}

function getResource(resources: PlannedResource[], kind: string): PlannedResource | undefined {
  return resources.find((r) => r.kind === kind);
}

export { buildViewerRequestFunctionCode } from './static-site-viewer';

export class ArtifactStack extends Stack {
  constructor(scope: Construct, id: string, props: ArtifactStackProps) {
    super(scope, id, props);
    const { component, resources } = props;

    const websiteResource = getResource(resources, 's3WebsiteBucket');
    const aliasResource = getResource(resources, 'route53AliasForS3');
    const deployResource = getResource(resources, 's3ArtifactDeployment');
    // @intent Ignore s3StaticSiteDeployment here; CloudFront lives only on StaticSiteStack
    const staticSiteResource = getResource(resources, 's3StaticSiteDeployment');

    const bucketFromProps =
      (deployResource?.props?.bucket as string) ??
      (websiteResource?.props?.bucket as string);
    const prefixFromProps = (deployResource?.props?.prefix as string | undefined) ?? component.env;

    const website_domain =
      (websiteResource?.props?.website_domain as string) ??
      (aliasResource?.props?.website_domain as string);
    const hosted_zone_domain =
      (websiteResource?.props?.hosted_zone_domain as string) ??
      (aliasResource?.props?.hosted_zone_domain as string);

    // @intent Use bucket from infra file, else website_domain (domain→bucket for custom-domain website hosting)
    const bucketName = bucketFromProps ?? (website_domain || undefined);

    // @intent Sync: plan runs HeadBucket and sets ThonnasBucketExists; reference bucket when it exists in AWS, else create (no user flag)
    const bucketExistsKey = bucketName ? `ThonnasBucketExists:${bucketName}` : '';
    const bucketExistsInAws = bucketName && this.node.tryGetContext(bucketExistsKey) === 'true';

    const privateArtifactBucket =
      (websiteResource?.props?.privateArtifactBucket as boolean) ||
      (deployResource?.props?.privateArtifactBucket as boolean) ||
      false;

    if (bucketName) {
      console.log(`[ArtifactStack ${component.component}] bucket=${bucketName} privateArtifactBucket=${privateArtifactBucket} context(${bucketExistsKey})=${String(this.node.tryGetContext(bucketExistsKey))} bucketExistsInAws=${bucketExistsInAws}`);
    }

    let bucket: s3.IBucket | undefined;

    if (websiteResource || deployResource) {
      if (bucketExistsInAws && bucketName) {
        bucket = s3.Bucket.fromBucketName(this, 'Bucket', bucketName);
      } else {
        const usePublicWebsite = Boolean(website_domain && !privateArtifactBucket && !staticSiteResource);
        bucket = new s3.Bucket(this, 'Bucket', {
          bucketName,
          websiteIndexDocument: usePublicWebsite ? 'index.html' : undefined,
          websiteErrorDocument: usePublicWebsite ? 'index.html' : undefined,
          publicReadAccess: usePublicWebsite,
          blockPublicAccess: usePublicWebsite
            ? new s3.BlockPublicAccess({
                blockPublicAcls: false,
                blockPublicPolicy: false,
                ignorePublicAcls: false,
                restrictPublicBuckets: false,
              })
            : undefined,
          removalPolicy: RemovalPolicy.RETAIN,
        });
      }
    }

    // @intent Sync: for direct S3 website (no CloudFront), ensure public read policy when bucket was referenced and not private
    if (bucket && website_domain && bucketExistsInAws && !staticSiteResource && !privateArtifactBucket) {
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [bucket.arnForObjects('*')],
          principals: [new iam.StarPrincipal()],
        }),
      );
    }

    // @intent Grant the apply account root write on generations so release can upload
    if (bucket && deployResource) {
      const livePrefix = String(prefixFromProps).replace(/\/+$/, '');
      const objectStmt = new iam.PolicyStatement({
        sid: 'ReleasePrincipalObjects',
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [
          bucket.arnForObjects(`${livePrefix}/*`),
          bucket.arnForObjects('.thonnas-release/*'),
        ],
        principals: [new iam.AccountRootPrincipal()],
      });
      const listStmt = new iam.PolicyStatement({
        sid: 'ReleasePrincipalList',
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        principals: [new iam.AccountRootPrincipal()],
      });
      if (bucketExistsInAws && bucketName) {
        // @intent Imported buckets cannot use addToResourcePolicy; keep a stack-owned policy
        new s3.CfnBucketPolicy(this, 'ReleaseWritePolicy', {
          bucket: bucketName,
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'ReleasePrincipalObjects',
                Effect: 'Allow',
                Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
                Resource: [
                  `arn:aws:s3:::${bucketName}/${livePrefix}/*`,
                  `arn:aws:s3:::${bucketName}/.thonnas-release/*`,
                ],
                Principal: { AWS: `arn:${this.partition}:iam::${this.account}:root` },
              },
              {
                Sid: 'ReleasePrincipalList',
                Effect: 'Allow',
                Action: ['s3:ListBucket'],
                Resource: `arn:aws:s3:::${bucketName}`,
                Principal: { AWS: `arn:${this.partition}:iam::${this.account}:root` },
              },
            ],
          },
        });
      } else {
        bucket.addToResourcePolicy(objectStmt);
        bucket.addToResourcePolicy(listStmt);
      }
    }

    // @intent Website-bucket-only (no static resource) stays S3 website DNS; never CloudFront
    if (bucket && website_domain && hosted_zone_domain && !staticSiteResource) {
      const zone = route53.HostedZone.fromLookup(this, 'Zone', {
        domainName: hosted_zone_domain,
      });
      const zoneSuffix = hosted_zone_domain.replace(/\.$/, '');
      const recordName = website_domain.endsWith(zoneSuffix)
        ? website_domain.slice(0, -zoneSuffix.length - 1).replace(/\.$/, '')
        : website_domain;
      // @intent Keep DNS in the template so stack-managed records are not deleted on no-op/update applies.
      new route53.ARecord(this, 'Alias', {
        zone,
        recordName,
        target: route53.RecordTarget.fromAlias(new route53Targets.BucketWebsiteTarget(bucket)),
      });
    }
  }
}



