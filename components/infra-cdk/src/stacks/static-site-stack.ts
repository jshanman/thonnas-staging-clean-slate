// @intent Own CloudFront, ACM, OAC, DNS, SPA rewrite, and optional cookie gate only
import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { PlannedResource, ResolvedCloudComponent } from '../types';
import { buildViewerRequestFunctionCode } from './static-site-viewer';

export interface StaticSiteStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  /** Planned resources (s3WebsiteBucket, route53AliasForS3, s3StaticSiteDeployment) */
  resources: PlannedResource[];
  /** When ArtifactStack also exists for this component, import the origin instead of creating it. */
  importOriginBucket?: boolean;
}

function getResource(resources: PlannedResource[], kind: string): PlannedResource | undefined {
  return resources.find((r) => r.kind === kind);
}

export { buildViewerRequestFunctionCode } from './static-site-viewer';

// @intent Emit CF/ACM/OAC/DNS for infra.website.static; import leftover origin and dist
export class StaticSiteStack extends Stack {
  constructor(scope: Construct, id: string, props: StaticSiteStackProps) {
    super(scope, id, props);
    const { component, resources } = props;

    const websiteResource = getResource(resources, 's3WebsiteBucket');
    const aliasResource = getResource(resources, 'route53AliasForS3');
    const staticSiteResource = getResource(resources, 's3StaticSiteDeployment');

    const website_domain =
      (staticSiteResource?.props?.website_domain as string) ??
      (websiteResource?.props?.website_domain as string) ??
      (aliasResource?.props?.website_domain as string);
    const hosted_zone_domain =
      (staticSiteResource?.props?.hosted_zone_domain as string) ??
      (websiteResource?.props?.hosted_zone_domain as string) ??
      (aliasResource?.props?.hosted_zone_domain as string);

    if (!website_domain?.trim() || !hosted_zone_domain?.trim()) {
      throw new Error(
        `StaticSiteStack ${component.component}: website_domain and hosted_zone_domain are required for s3StaticSiteDeployment.`,
      );
    }

    const bucketFromProps =
      (websiteResource?.props?.bucket as string) ??
      (staticSiteResource?.props?.bucket as string) ??
      website_domain;
    const bucketName = bucketFromProps || website_domain;
    const bucketExistsKey = bucketName ? `ThonnasBucketExists:${bucketName}` : '';
    const bucketExistsInAws = Boolean(bucketName && this.node.tryGetContext(bucketExistsKey) === 'true');
    const importOnly = Boolean(props.importOriginBucket) || bucketExistsInAws;

    console.log(
      `[StaticSiteStack ${component.component}] bucket=${bucketName} context(${bucketExistsKey})=${String(this.node.tryGetContext(bucketExistsKey))} importOnly=${importOnly}`,
    );

    let bucket: s3.IBucket;
    if (importOnly && bucketName) {
      bucket = s3.Bucket.fromBucketName(this, 'Bucket', bucketName);
    } else {
      bucket = new s3.Bucket(this, 'Bucket', {
        bucketName,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    }

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: hosted_zone_domain,
    });
    const zoneSuffix = hosted_zone_domain.replace(/\.$/, '');
    const recordName = website_domain.endsWith(zoneSuffix)
      ? website_domain.slice(0, -zoneSuffix.length - 1).replace(/\.$/, '')
      : website_domain;

    const existingCertArn = this.node.tryGetContext(`ThonnasCertArn:${website_domain}`) as string | undefined;
    const certPending = this.node.tryGetContext(`ThonnasCertPending:${website_domain}`) === 'true';
    const certStatusIssued = this.node.tryGetContext(`ThonnasCertStatus:${website_domain}`) === 'ISSUED';
    const creatingNewCert = !existingCertArn;
    const cert = existingCertArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', existingCertArn)
      : (() => {
          const c = new acm.Certificate(this, 'Cert', {
            domainName: website_domain,
            validation: acm.CertificateValidation.fromDns(zone),
          });
          // @intent Retain cert when stack later switches to fromCertificateArn so CloudFront-using cert is not deleted
          c.applyRemovalPolicy(RemovalPolicy.RETAIN);
          return c;
        })();

    // @intent Create CloudFront only when cert is ISSUED in us-east-1; skip when creating new cert or pending validation
    const skipCloudFrontUntilCertReady = !certStatusIssued || certPending || creatingNewCert;
    if (skipCloudFrontUntilCertReady) {
      if (creatingNewCert) {
        console.log(
          `[StaticSiteStack ${component.component}] Creating ACM certificate only for ${website_domain}; CloudFront will be created after cert is issued.`,
        );
      }
      console.log(`
*** NOT ALL RESOURCES WERE CREATED ***
The SSL certificate for ${website_domain} is ${creatingNewCert ? 'being created and' : 'still'} validating.
CloudFront and the DNS A record were skipped. Validation can take up to 30 minutes.

What to do:
  1. Ensure the ACM validation CNAME is present in Route53 (see ACM console, us-east-1).
  2. Wait for the certificate to show "Issued" in ACM (often 1–30 minutes).
  3. Run again: thonnas infra plan --env <your-env> && thonnas infra apply --env <your-env>

Then CloudFront and the A record will be created.
***`);
      return;
    }

    const existingDistId = this.node.tryGetContext(`ThonnasDistributionId:${website_domain}`) as string | undefined;
    const existingDistDomain = this.node.tryGetContext(`ThonnasDistributionDomainName:${website_domain}`) as
      | string
      | undefined;
    const dist =
      existingDistId && existingDistDomain
        ? cloudfront.Distribution.fromDistributionAttributes(this, 'Distribution', {
            distributionId: existingDistId,
            domainName: existingDistDomain,
          })
        : undefined;
    // @intent S3 has no directory index; optionally gate docs behind a frontend terms cookie.
    const viewerRequestFn = new cloudfront.Function(this, 'ViewerRequest', {
      code: cloudfront.FunctionCode.fromInline(
        buildViewerRequestFunctionCode(staticSiteResource?.props?.accessControl),
      ),
      comment: 'Static site viewer request handling',
    });
    const distResolved =
      dist ??
      new cloudfront.Distribution(this, 'Distribution', {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          functionAssociations: [
            { function: viewerRequestFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        defaultRootObject: 'index.html',
        errorResponses: [
          { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
          { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        ],
        domainNames: [website_domain],
        certificate: cert,
      });

    const bucketPolicyHasOAC = this.node.tryGetContext(`ThonnasBucketPolicyHasOAC:${bucket.bucketName}`) === 'true';
    if (!bucketPolicyHasOAC) {
      new s3.CfnBucketPolicy(this, 'OACBucketPolicy', {
        bucket: bucket.bucketName,
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AllowCloudFrontOAC',
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
              Resource: bucket.arnForObjects('*'),
              Condition: {
                StringEquals: {
                  'aws:SourceArn': distResolved.distributionArn,
                },
              },
            },
          ],
        },
      });
    }

    const skipAlias = this.node.tryGetContext(`ThonnasSkipStaticSiteAlias:${website_domain}`) === 'true';
    if (!skipAlias) {
      // @intent Keep DNS in the template so stack-managed records are not deleted on no-op/update applies.
      new route53.ARecord(this, 'Alias', {
        zone,
        recordName,
        target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distResolved)),
      });
    } else {
      console.log(
        `[StaticSiteStack ${component.component}] Skipping Route53 A for ${website_domain}; leftover alias still points at the imported distribution.`,
      );
    }

    new CfnOutput(this, 'WebsiteBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distResolved.distributionId });
    new CfnOutput(this, 'WebsiteDomain', { value: website_domain });
  }
}



