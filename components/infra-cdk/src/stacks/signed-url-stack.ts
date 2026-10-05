// @intent Prepare placeholder function + live alias + front door; do not ship app code
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { PlannedResource, ResolvedCloudComponent } from '../types';

export const SIGNED_URL_ALIAS = 'live';

export interface SignedUrlStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  resources: PlannedResource[];
  projectRoot: string;
}

export interface SignedUrlPolicyStatement {
  actions: string[];
  resources: string[];
}

function getResource(resources: PlannedResource[], kind: string): PlannedResource | undefined {
  return resources.find((r) => r.kind === kind);
}

/** @intent Lambda FunctionUrl.url is a deploy-time token; string .replace() does not strip https — CloudFront rejects colons in origin name */
function lambdaUrlOriginHostname(functionUrl: string): string {
  const afterScheme = Fn.select(1, Fn.split('//', functionUrl));
  return Fn.select(0, Fn.split('/', afterScheme));
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function asPolicyStatements(value: unknown): SignedUrlPolicyStatement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const actions = (item as { actions?: unknown }).actions;
    const resources = (item as { resources?: unknown }).resources;
    if (!Array.isArray(actions) || !Array.isArray(resources)) return [];
    const actionStrs = actions.filter((a): a is string => typeof a === 'string');
    const resourceStrs = resources.filter((r): r is string => typeof r === 'string');
    if (actionStrs.length === 0 || resourceStrs.length === 0) return [];
    return [{ actions: actionStrs, resources: resourceStrs }];
  });
}

// @intent Resolve lockfile from the declaring component, not infra-cdk
export function resolveDeclaringComponentLockfile(
  projectRoot: string,
  component: string,
): { componentDir: string; depsLockFilePath: string } {
  const componentDir = path.join(projectRoot, 'components', component);
  const depsLockFilePath = path.join(componentDir, 'package-lock.json');
  if (!fs.existsSync(depsLockFilePath)) {
    throw new Error(
      `Declaring component package-lock.json not found at ${depsLockFilePath}; required for Lambda bundling of infra.api.storage-temp-url.`,
    );
  }
  return { componentDir, depsLockFilePath };
}

// @intent Inject generic STORAGE_* plus one-phase THONNAS_ARTIFACT_* fallback
export function mergeSignedUrlEnvironment(options: {
  bucket: string;
  prefix: string;
  bucketRegion?: string;
  extrasEnv?: unknown;
}): Record<string, string> {
  const base: Record<string, string> = {
    STORAGE_BUCKET: options.bucket,
    STORAGE_PREFIX: options.prefix,
    THONNAS_ARTIFACT_BUCKET: options.bucket,
    THONNAS_ARTIFACT_PREFIX: options.prefix,
  };
  if (options.bucketRegion) {
    base.STORAGE_BUCKET_REGION = options.bucketRegion;
    base.THONNAS_ARTIFACT_BUCKET_REGION = options.bucketRegion;
  }
  return { ...base, ...asStringMap(options.extrasEnv) };
}

// @intent Deterministic function name for release lookup (not a workshop guess)
export function signedUrlFunctionName(env: string, component: string): string {
  return `${env}-${component}-signed-url`.slice(0, 64);
}

export class SignedUrlStack extends Stack {
  constructor(scope: Construct, id: string, props: SignedUrlStackProps) {
    super(scope, id, props);
    const { profile, component, resources } = props;

    const resource = getResource(resources, 'storageTempUrlApi');
    if (!resource?.props) return;

    const bucket = resource.props.bucket as string;
    const prefix = (resource.props.prefix as string) || profile.envKey;
    const api_domain = resource.props.api_domain as string;
    const hosted_zone_domain = (resource.props.hosted_zone_domain as string) || '';
    const bucket_region =
      typeof resource.props.bucket_region === 'string' && resource.props.bucket_region.trim().length > 0
        ? resource.props.bucket_region.trim()
        : undefined;
    const functionName =
      (typeof resource.props.functionName === 'string' && resource.props.functionName.trim()) ||
      signedUrlFunctionName(component.env, component.component);

    // @intent Placeholder only — release publishes the application body
    const fn = new lambda.Function(this, 'SignedUrlHandler', {
      functionName,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      environment: mergeSignedUrlEnvironment({
        bucket,
        prefix,
        bucketRegion: bucket_region,
        extrasEnv: resource.props.env,
      }),
      code: lambda.Code.fromInline(
        "exports.handler = async () => ({ statusCode: 503, body: 'not released' });",
      ),
    });

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${bucket}/${prefix}/*`],
      }),
    );
    for (const statement of asPolicyStatements(resource.props.policyStatements)) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: statement.actions,
          resources: statement.resources,
        }),
      );
    }

    const alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: SIGNED_URL_ALIAS,
      version: fn.currentVersion,
    });

    const fnUrl = alias.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ['*'],
      },
    });

    new CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new CfnOutput(this, 'FunctionAlias', { value: alias.aliasName });

    const fnUrlHostname = lambdaUrlOriginHostname(fnUrl.url);

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: hosted_zone_domain,
    });

    const existingCertArn = this.node.tryGetContext(`ThonnasCertArn:${api_domain}`) as string | undefined;
    const certPending = this.node.tryGetContext(`ThonnasCertPending:${api_domain}`) === 'true';
    const certStatusIssued = this.node.tryGetContext(`ThonnasCertStatus:${api_domain}`) === 'ISSUED';
    const creatingNewCert = !existingCertArn;
    const cert = existingCertArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', existingCertArn)
      : new acm.Certificate(this, 'Cert', {
          domainName: api_domain,
          validation: acm.CertificateValidation.fromDns(zone),
        });
    if (!existingCertArn) {
      (cert as acm.Certificate).applyRemovalPolicy(RemovalPolicy.RETAIN);
    }

    const skipCloudFront = !certStatusIssued || certPending || creatingNewCert;
    if (skipCloudFront) {
      console.log(
        `[SignedUrlStack ${component.component}] ACM cert for ${api_domain} not ready; CloudFront/DNS skipped. Run plan+apply after cert is ISSUED.`,
      );
      return;
    }

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(fnUrlHostname, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          customHeaders: {
            'X-Forwarded-Host': api_domain,
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        /** @intent Forward ?query= to Lambda URL; CACHING_DISABLED alone can omit query string at origin */
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      domainNames: [api_domain],
      certificate: cert,
      defaultRootObject: '',
      errorResponses: [],
    });

    const zoneSuffix = hosted_zone_domain.replace(/\.$/, '');
    const recordName = api_domain.endsWith(zoneSuffix)
      ? api_domain.slice(0, -zoneSuffix.length - 1).replace(/\.$/, '')
      : api_domain;
    // @intent Always define alias in stack; skipping via ThonnasARecordExists caused CFN to delete the record on update
    new route53.ARecord(this, 'Alias', {
      zone,
      recordName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });
  }
}



