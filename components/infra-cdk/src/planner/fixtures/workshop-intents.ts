import { DeploymentIntent } from '../../types';

// @intent Anonymous workshop topology; never special-case api-nest or tm-user-count in CDK

export const workshopIntents = (): DeploymentIntent[] => [
  {
    component: 'fixture-web',
    componentPath: 'components/fixture-web',
    thonnasInfraVersion: 1,
    domainPattern: `{env}.{component}.example.local`,
    strategies: {
      website: { key: 'infra.website.static', extras: { outputPath: 'build', bucket: 'fixture-web-bucket' } },
    },
    environments: {},
    requiredSecrets: [],
  },
  {
    component: 'fixture-api',
    componentPath: 'components/fixture-api',
    thonnasInfraVersion: 1,
    domainPattern: `{env}.{component}.example.local`,
    strategies: {
      runtime: {
        key: 'infra.container.managed-host',
        ports: [3000],
        exposed: true,
        extras: { protocols: ['mqtt', 'ws'] },
      },
    },
    environments: {},
    requiredSecrets: [],
  },
  {
    component: 'fixture-pg',
    componentPath: 'components/fixture-pg',
    thonnasInfraVersion: 1,
    domainPattern: `{env}.{component}.example.local`,
    strategies: {
      database: { key: 'infra.db.relational', engine: 'postgres' },
    },
    environments: {},
    requiredSecrets: [],
  },
  {
    component: 'fixture-doc',
    componentPath: 'components/fixture-doc',
    thonnasInfraVersion: 1,
    domainPattern: `{env}.{component}.example.local`,
    strategies: {
      database: { key: 'infra.db.document', engine: 'mongodb-compatible' },
    },
    environments: {},
    requiredSecrets: [],
  },
  {
    component: 'fixture-cache',
    componentPath: 'components/fixture-cache',
    thonnasInfraVersion: 1,
    domainPattern: `{env}.{component}.example.local`,
    strategies: {
      cache: { key: 'infra.cache.keyvalue', engine: 'redis' },
    },
    environments: {},
    requiredSecrets: [],
  },
  {
    component: 'fixture-temporal',
    componentPath: 'components/fixture-temporal',
    thonnasInfraVersion: 1,
    domainPattern: `{env}.{component}.example.local`,
    strategies: {
      worker: { key: 'infra.worker.temporal' },
    },
    environments: {},
    requiredSecrets: [],
  },
  {
    component: 'fixture-temporal-ui',
    componentPath: 'components/fixture-temporal-ui',
    thonnasInfraVersion: 1,
    domainPattern: `{env}.{component}.example.local`,
    strategies: {
      runtime: { key: 'infra.container.managed-host', ports: [8080], exposed: true },
    },
    environments: {},
    requiredSecrets: [],
  },
  {
    component: 'fixture-observe',
    componentPath: 'components/fixture-observe',
    thonnasInfraVersion: 1,
    domainPattern: `{env}.{component}.example.local`,
    strategies: {
      metrics: { key: 'infra.observe.metrics' },
      dashboard: { key: 'infra.observe.dashboard' },
    },
    environments: {},
    requiredSecrets: [],
  },
];



