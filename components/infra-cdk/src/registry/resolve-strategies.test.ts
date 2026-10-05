import { describe, expect, it } from '@jest/globals';
import { resolveStrategies } from './resolve-strategies';
import { DeploymentIntent } from '../types';

const mockIntent = (overrides?: Partial<DeploymentIntent>): DeploymentIntent => ({
  component: 'api',
  componentPath: 'components/api',
  thonnasInfraVersion: 1,
  domainPattern: '{env}.{component}.example.local',
  strategies: {
    runtime: {
      key: 'infra.container.cluster',
      ports: [3000],
      exposed: true,
    },
    database: {
      key: 'infra.db.relational',
      engine: 'postgres',
    },
  },
  environments: {},
  requiredSecrets: [],
  ...overrides,
});

const defaultOptions = {
  env: 'beta',
  rootDomain: 'example.local',
  gitPasswordSecretName: 'TEST_PROJECT_GIT_PWD',
};

describe('resolveStrategies', () => {
  it('maps runtime strategy to ECS service + resources', () => {
    const intents = [mockIntent()];
    const result = resolveStrategies(intents, defaultOptions);

    const ecsComponent = result.components.find((c) => c.strategy === 'runtime');
    expect(ecsComponent).toBeDefined();
    expect(ecsComponent?.construct).toBe('ECSFargateService');
    expect(ecsComponent?.metadata.hostname).toBe('beta.api.example.local');
    expect(ecsComponent?.metadata.ports).toEqual([3000]);

    const resourceKinds = result.resources.reduce<Record<string, number>>((acc, resource) => {
      acc[resource.kind] = (acc[resource.kind] || 0) + 1;
      return acc;
    }, {});
    expect(resourceKinds.ecrRepository).toBe(1);
    expect(resourceKinds.securityGroup).toBeGreaterThanOrEqual(2);
    expect(resourceKinds.iamRole).toBeGreaterThanOrEqual(2);
    expect(resourceKinds.logGroup).toBe(1);
    const ecr = result.resources.find((r) => r.kind === 'ecrRepository');
    expect(ecr?.props.name).toBe('beta-api');
  });

  it('prefixes planned ECR repository names with projectName when set', () => {
    const intents = [mockIntent()];
    const result = resolveStrategies(intents, { ...defaultOptions, projectName: 'e2efe001' });
    const ecr = result.resources.find((r) => r.kind === 'ecrRepository');
    expect(ecr?.props.name).toBe('e2efe001/beta-api');
    expect(ecr?.props.uriTemplate).toContain('e2efe001/beta-api');
  });

  it('maps relational db strategy to RDS construct with DB security group', () => {
    const intents = [mockIntent()];
    const result = resolveStrategies(intents, defaultOptions);
    const dbComponent = result.components.find((c) => c.strategy === 'database');
    expect(dbComponent?.construct).toBe('RdsPostgresInstance');

    const dbSecurityGroup = result.resources.find((r) => r.id.includes('db-sg'));
    expect(dbSecurityGroup).toBeDefined();
    expect(dbSecurityGroup?.props).toMatchObject({
      ingress: [{ port: 5432, source: 'sg-beta-api-ecs-sg' }],
    });
    const dbSecret = result.resources.find((r) => r.kind === 'dbSecret');
    expect(dbSecret?.props.secretName).toBe('beta/api/postgres');
    expect(dbSecurityGroup?.props.ingress).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: '0.0.0.0/0' })]),
    );
  });

  it('copies relational extras onto component metadata that RdsStack reads', () => {
    const intents = [
      mockIntent({
        component: 'fixture-db',
        componentPath: 'components/fixture-db',
        strategies: {
          database: {
            key: 'infra.db.relational',
            engine: 'postgres',
            extras: {
              secretName: 'beta/fixture-db/custom',
              peerSecurityGroupIds: ['sg-0123456789abcdef0'],
            },
          },
        },
      }),
    ];
    const result = resolveStrategies(intents, defaultOptions);
    const dbComponent = result.components.find((c) => c.strategy === 'database');
    expect(dbComponent?.metadata.extras?.secretName).toBe('beta/fixture-db/custom');
    expect(dbComponent?.metadata.extras?.peerSecurityGroupIds).toEqual(['sg-0123456789abcdef0']);
    expect(dbComponent?.metadata.extras?.engine).toBe('postgres');
    const dbSecret = result.resources.find((r) => r.kind === 'dbSecret');
    expect(dbSecret?.props.secretName).toBe('beta/fixture-db/custom');
    const dbSecurityGroup = result.resources.find((r) => r.id.includes('db-sg'));
    expect(dbSecurityGroup?.props.ingress).toEqual(
      expect.arrayContaining([expect.objectContaining({ port: 5432, source: 'sg-0123456789abcdef0' })]),
    );
  });

  it('maps document db strategy to DocumentDB construct with SG and secret', () => {
    const intents = [
      mockIntent({
        component: 'fixture-doc',
        componentPath: 'components/fixture-doc',
        strategies: {
          database: {
            key: 'infra.db.document',
            engine: 'mongodb-compatible',
            extras: { secretName: 'beta/fixture-doc/docdb' },
          },
        },
      }),
    ];
    const result = resolveStrategies(intents, defaultOptions);
    const dbComponent = result.components.find((c) => c.strategy === 'database');
    expect(dbComponent?.construct).toBe('AwsDocumentDbCluster');

    const docSg = result.resources.find((r) => r.id.includes('docdb-sg'));
    expect(docSg).toBeDefined();
    expect(docSg?.props).toMatchObject({
      ingress: [{ port: 27017, source: 'sg-beta-fixture-doc-ecs-sg' }],
    });
    const dbSecret = result.resources.find((r) => r.kind === 'dbSecret');
    expect(dbSecret?.props.secretName).toBe('beta/fixture-doc/docdb');
  });

  it('maps two anonymous document components to the same construct family', () => {
    const intents = [
      mockIntent({
        component: 'fixture-doc',
        componentPath: 'components/fixture-doc',
        strategies: { database: { key: 'infra.db.document', engine: 'mongodb-compatible' } },
      }),
      mockIntent({
        component: 'fixture-data',
        componentPath: 'components/fixture-data',
        strategies: { document: { key: 'infra.db.document', engine: 'mongodb-compatible' } },
      }),
    ];
    const result = resolveStrategies(intents, defaultOptions);
    const constructs = result.components
      .filter((c) => c.strategy === 'database' || c.strategy === 'document')
      .map((c) => c.construct);
    expect(constructs).toEqual(['AwsDocumentDbCluster', 'AwsDocumentDbCluster']);
    const secretNames = result.resources.filter((r) => r.kind === 'dbSecret').map((r) => r.props.secretName);
    expect(secretNames).toEqual(expect.arrayContaining(['beta/fixture-doc/docdb', 'beta/fixture-data/docdb']));
  });

  it('prefixes planned document secret names with projectName when set', () => {
    const intents = [
      mockIntent({
        component: 'fixture-doc',
        componentPath: 'components/fixture-doc',
        strategies: { database: { key: 'infra.db.document', engine: 'mongodb-compatible' } },
      }),
    ];
    const result = resolveStrategies(intents, { ...defaultOptions, projectName: 'MyApp' });
    const dbSecret = result.resources.find((r) => r.kind === 'dbSecret');
    expect(dbSecret?.props.secretName).toBe('myapp/beta/fixture-doc/docdb');
  });

  it('maps cache strategy to Redis construct with SG and secret', () => {
    const intents = [
      mockIntent({
        component: 'fixture-cache',
        componentPath: 'components/fixture-cache',
        strategies: {
          cache: {
            key: 'infra.cache.keyvalue',
            engine: 'redis',
            extras: { secretName: 'beta/fixture-cache/redis', peerSecurityGroupIds: ['sg-0123456789abcdef0'] },
          },
        },
      }),
    ];
    const result = resolveStrategies(intents, defaultOptions);
    const cacheComponent = result.components.find((c) => c.strategy === 'cache');
    expect(cacheComponent?.construct).toBe('ElasticacheRedisCluster');
    expect(cacheComponent?.metadata.extras?.secretName).toBe('beta/fixture-cache/redis');
    expect(cacheComponent?.metadata.extras?.engine).toBe('redis');

    const cacheSg = result.resources.find((r) => r.id.includes('cache-sg'));
    expect(cacheSg).toBeDefined();
    expect(cacheSg?.props.ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ port: 6379, source: 'sg-beta-fixture-cache-ecs-sg' }),
        expect.objectContaining({ port: 6379, source: 'sg-0123456789abcdef0' }),
      ]),
    );
    const cacheSecret = result.resources.find((r) => r.id.includes('cache') && r.kind === 'dbSecret');
    expect(cacheSecret?.props.secretName).toBe('beta/fixture-cache/redis');
  });


  it('maps two anonymous relational components to the same construct family', () => {
    const intents = [
      mockIntent({
        component: 'fixture-db',
        componentPath: 'components/fixture-db',
        strategies: { database: { key: 'infra.db.relational', engine: 'postgres' } },
      }),
      mockIntent({
        component: 'fixture-data',
        componentPath: 'components/fixture-data',
        strategies: { database: { key: 'infra.db.relational', engine: 'postgres' } },
      }),
    ];
    const result = resolveStrategies(intents, defaultOptions);
    const constructs = result.components.filter((c) => c.strategy === 'database').map((c) => c.construct);
    expect(constructs).toEqual(['RdsPostgresInstance', 'RdsPostgresInstance']);
  });

  it('supports simple-vm runtime with EC2 resources', () => {
    const intents = [
      mockIntent({
        component: 'api-web',
        strategies: {
          runtime: {
            key: 'infra.container.simple-vm',
            ports: [8080],
          },
        },
      }),
    ];
    const result = resolveStrategies(intents, defaultOptions);
    const runtime = result.components.find((c) => c.strategy === 'runtime');
    expect(runtime?.construct).toBe('SingleEC2DockerHost');
    expect(runtime?.metadata.routing).toBe('direct');
    expect(result.resources.some((r) => r.kind === 'securityGroup' && r.id.includes('ec2'))).toBe(true);
  });

  it('maps compose-host strategy to single compose host with DNS records', () => {
    const intents: DeploymentIntent[] = [
      mockIntent({
        component: 'infra-docker',
        strategies: {
          composeHost: {
            key: 'infra.container.compose-host',
            extras: {
              gitRepositoryUrl: 'https://github.com/example/project.git',
              publishedServices: [
                { name: 'api', port: 3000, hostnamePattern: '{env}.api.{rootDomain}' },
                { name: 'web', port: 4200, hostnamePattern: '{env}.web.{rootDomain}' },
              ],
            },
          },
        },
      }),
    ];

    const result = resolveStrategies(intents, {
      ...defaultOptions,
      gitTag: 'feature/test-branch',
    });

    const composeComponent = result.components.find((c) => c.strategy === 'composeHost');
    expect(composeComponent?.construct).toBe('ComposeHostEc2');
    expect(composeComponent?.metadata.compose?.publishedServices).toHaveLength(2);
    expect(composeComponent?.metadata.compose?.gitPasswordSecretName).toBe('TEST_PROJECT_GIT_PWD');
    expect(result.resources.some((r) => r.kind === 'dnsRecord')).toBe(true);
    expect(result.resources.some((r) => r.kind === 'elasticIp')).toBe(true);
  });

  it('uses deploySlug for {deploy-slug} in compose hostnames; gitTag does not affect hostnames', () => {
    const intents: DeploymentIntent[] = [
      mockIntent({
        component: 'infra-docker',
        strategies: {
          composeHost: {
            key: 'infra.container.compose-host',
            extras: {
              gitRepositoryUrl: 'https://github.com/example/project.git',
              publishedServices: [
                {
                  name: 'api',
                  port: 3000,
                  hostnamePattern: '{deploy-slug}.{env}.api.{rootDomain}',
                },
              ],
            },
          },
        },
      }),
    ];

    const withSlug = resolveStrategies(intents, {
      ...defaultOptions,
      gitTag: 'feature/ignored-for-hosts',
      deploySlug: 'feat-abc',
    });
    const svc = withSlug.components.find((c) => c.strategy === 'composeHost')?.metadata.compose
      ?.publishedServices?.[0];
    expect(svc?.hostname).toBe('feat-abc.beta.api.example.local');

    const noSlug = resolveStrategies(intents, {
      ...defaultOptions,
      gitTag: 'feature/only-checkout',
    });
    const svc2 = noSlug.components.find((c) => c.strategy === 'composeHost')?.metadata.compose
      ?.publishedServices?.[0];
    expect(svc2?.hostname).toBe('beta.api.example.local');
  });

  it('passes static site accessControl extras through to planned resources', () => {
    const accessControl = {
      type: 'frontend-cookie-gate',
      cookieName: 'gate_cookie',
      cookieValue: 'accepted',
      challengePath: '/gate',
      publicPaths: ['/gate', '/gate/*'],
    };
    const result = resolveStrategies([
      mockIntent({
        component: 'web-react-docusaurus',
        strategies: {
          staticSite: {
            key: 'infra.website.static',
            extras: {
              outputPath: 'build',
              website_domain: '{env}.docs.{rootDomain}',
              hosted_zone_domain: 'example.local',
              accessControl,
            },
          },
        },
      }),
    ], defaultOptions);

    const staticSite = result.resources.find((resource) => resource.kind === 's3StaticSiteDeployment');
    expect(staticSite?.props).toMatchObject({
      outputPath: 'build',
      website_domain: 'beta.docs.example.local',
      hosted_zone_domain: 'example.local',
      accessControl,
    });
  });

  it('omits unrelated strategies when strategyFilter is set', () => {
    const result = resolveStrategies([mockIntent()], {
      ...defaultOptions,
      strategyFilter: ['infra.website.static'],
    });
    expect(result.components).toHaveLength(0);
    expect(result.resources).toHaveLength(0);
  });

  it('keeps relational when strategyFilter is infra.db.relational', () => {
    const result = resolveStrategies([mockIntent()], {
      ...defaultOptions,
      strategyFilter: ['infra.db.relational'],
    });
    expect(result.components.some((c) => c.construct === 'RdsPostgresInstance')).toBe(true);
    expect(result.components.some((c) => c.strategy === 'runtime')).toBe(false);
  });

  it('plans s3WebsiteBucket and s3StaticSiteDeployment with outputPath for fixture-web', () => {
    const result = resolveStrategies(
      [
        mockIntent({
          component: 'fixture-web',
          strategies: {
            website: {
              key: 'infra.website.static',
              extras: { outputPath: 'build' },
            },
          },
        }),
      ],
      defaultOptions,
    );
    expect(result.resources.some((resource) => resource.kind === 's3WebsiteBucket')).toBe(true);
    const staticSite = result.resources.find((resource) => resource.kind === 's3StaticSiteDeployment');
    expect(staticSite?.props).toMatchObject({ outputPath: 'build' });
  });

  it('forwards storage-temp-url extras.env and policyStatements', () => {
    const extrasEnv = { CUSTOM_FLAG: '1' };
    const policyStatements = [{ actions: ['s3:ListBucket'], resources: ['arn:aws:s3:::fixture-signed-url-bucket'] }];
    const result = resolveStrategies(
      [
        mockIntent({
          component: 'fixture-signed-url',
          componentPath: 'components/fixture-signed-url',
          strategies: {
            storageTempUrl: {
              key: 'infra.api.storage-temp-url',
              extras: {
                bucket: 'fixture-signed-url-bucket',
                prefix: 'staging',
                api_domain: '{env}.{component}.{rootDomain}',
                hosted_zone_domain: '{rootDomain}',
                env: extrasEnv,
                policyStatements,
              },
            },
          },
        }),
      ],
      { ...defaultOptions, env: 'staging', rootDomain: 'example.test' },
    );
    const planned = result.resources.find((resource) => resource.kind === 'storageTempUrlApi');
    expect(planned?.props).toMatchObject({
      bucket: 'fixture-signed-url-bucket',
      api_domain: 'staging.fixture-signed-url.example.test',
      hosted_zone_domain: 'example.test',
      env: extrasEnv,
      policyStatements,
    });
  });

  it('interpolates {component} in website_domain and copies extras.bucket onto website resources', () => {
    const result = resolveStrategies(
      [
        mockIntent({
          component: 'fixture-web',
          strategies: {
            website: {
              key: 'infra.website.static',
              extras: {
                outputPath: 'build',
                bucket: 'live-feat001-ts1-fixture-web-550536272394',
                website_domain: '{env}.{component}.{rootDomain}',
                hosted_zone_domain: '{rootDomain}',
              },
            },
          },
        }),
      ],
      { ...defaultOptions, env: 'staging', rootDomain: 'ts1.parfiamlabs.com' },
    );
    const website = result.resources.find((resource) => resource.kind === 's3WebsiteBucket');
    const staticSite = result.resources.find((resource) => resource.kind === 's3StaticSiteDeployment');
    expect(website?.props).toMatchObject({
      website_domain: 'staging.fixture-web.ts1.parfiamlabs.com',
      hosted_zone_domain: 'ts1.parfiamlabs.com',
      bucket: 'live-feat001-ts1-fixture-web-550536272394',
    });
    expect(staticSite?.props).toMatchObject({
      website_domain: 'staging.fixture-web.ts1.parfiamlabs.com',
      bucket: 'live-feat001-ts1-fixture-web-550536272394',
    });
  });

  it('requires compose-host git repository URL from env or extras', () => {
    const intents: DeploymentIntent[] = [
      mockIntent({
        component: 'infra-docker',
        strategies: {
          composeHost: {
            key: 'infra.container.compose-host',
            extras: {},
          },
        },
      }),
    ];
    expect(() => resolveStrategies(intents, defaultOptions)).toThrow(/git repository URL/i);
  });

  it('defaults compose-host git password secret name to GIT_CLONE_PASSWORD', () => {
    const optionsWithoutSecret = { env: defaultOptions.env, rootDomain: defaultOptions.rootDomain };
    const intents: DeploymentIntent[] = [
      mockIntent({
        component: 'infra-docker',
        strategies: {
          composeHost: {
            key: 'infra.container.compose-host',
            extras: { gitRepositoryUrl: 'https://github.com/example/project.git' },
          },
        },
      }),
    ];
    const result = resolveStrategies(intents, optionsWithoutSecret);
    expect(
      result.components.find((c) => c.strategy === 'composeHost')?.metadata.compose?.gitPasswordSecretName,
    ).toBe('GIT_CLONE_PASSWORD');
  });

  it('plans snsSqsEventBus from comms.events.pub-sub.sns and skips localstack', () => {
    const intents = [
      mockIntent({
        component: 'queue-sns',
        strategies: {
          events: { key: 'comms.events.pub-sub.sns', extras: {} },
          localstack: { key: 'infra.aws.localstack', extras: { 'infra.aws.localstack.services': ['sns', 'sqs'] } },
        },
      }),
    ];
    const result = resolveStrategies(intents, defaultOptions);
    expect(result.components.find((c) => c.strategy === 'localstack')).toBeUndefined();
    const bus = result.resources.find((r) => r.kind === 'snsSqsEventBus');
    expect(bus).toBeDefined();
    expect(bus?.props).toMatchObject({ topicName: 'bt-thonnas-events' });
    expect(Array.isArray(bus?.props.queues)).toBe(true);
  });

  it('loads consumer queues from thonnas-events.json at plan time', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-bus-cdk-'));
    fs.mkdirSync(path.join(dir, 'mod'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mod', 'thonnas-events.json'),
      JSON.stringify({
        subscribes: [
          {
            consumerId: 'tm-user-entitlements',
            events: ['commerce.entitlement.granted'],
            filter: { eventType: ['commerce.entitlement.granted'] },
          },
        ],
      }),
    );
    try {
      const result = resolveStrategies(
        [
          mockIntent({
            component: 'queue-sns',
            strategies: { events: { key: 'comms.events.pub-sub.sns', extras: {} } },
          }),
        ],
        { ...defaultOptions, projectRoot: dir },
      );
      const bus = result.resources.find((r) => r.kind === 'snsSqsEventBus');
      expect(bus?.props.queues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            consumerId: 'tm-user-entitlements',
            queueName: 'bt-thonnas-tm-user-entitlements',
            dlqName: 'bt-thonnas-tm-user-entitlements-dlq',
          }),
        ]),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefixes snsSqsEventBus names with projectName', () => {
    const result = resolveStrategies(
      [
        mockIntent({
          component: 'queue-sns',
          strategies: { events: { key: 'comms.events.pub-sub.sns', extras: {} } },
        }),
      ],
      { ...defaultOptions, env: 'staging', projectName: 'feat001stg' },
    );
    const bus = result.resources.find((r) => r.kind === 'snsSqsEventBus');
    expect(bus?.props).toMatchObject({ topicName: 'feat001stg-st-thonnas-events' });
  });

  it('skips infra.bootstrap and plans githubOidcIdentity from infra.identity.oidc', () => {
    const intents = [
      mockIntent({
        component: 'cicd-github-actions',
        strategies: {
          bootstrap: {
            key: 'infra.bootstrap',
            extras: { priority: 1, command: 'bash scripts/bootstrap.sh' },
          },
          oidc: {
            key: 'infra.identity.oidc',
            extras: { issuer: 'github' },
          },
          website: {
            key: 'infra.storage',
            extras: { bucket: 'docs-bucket' },
          },
        },
      }),
    ];
    const all = resolveStrategies(intents, defaultOptions);
    expect(all.components.find((c) => c.strategy === 'bootstrap')).toBeUndefined();
    expect(all.resources.some((r) => r.kind === 'githubOidcIdentity')).toBe(true);
    expect(all.components.some((c) => c.construct === 'S3StorageBucket')).toBe(true);

    const filtered = resolveStrategies(intents, {
      ...defaultOptions,
      strategyFilter: ['infra.identity.oidc'],
    });
    expect(filtered.resources.map((r) => r.kind)).toEqual(['githubOidcIdentity']);
    expect(filtered.components).toHaveLength(0);
  });
});




