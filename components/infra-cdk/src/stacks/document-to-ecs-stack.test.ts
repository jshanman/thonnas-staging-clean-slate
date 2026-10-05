import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { DocDbStack } from './docdb-stack';
import { DocumentToEcsStack } from './document-to-ecs-stack';
import { EcsServiceStack } from './ecs-service-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const certArn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111';

const fixtureApi = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-api-runtime',
  component: 'fixture-api',
  env: 'staging',
  strategy: 'runtime',
  construct: 'ECSFargateService',
  scope: 'service',
  requires: [],
  metadata: {
    runtimeType: 'ecs-fargate',
    ports: [3000],
    exposed: true,
    hostname: 'staging-fixture-api.example.local',
    routing: 'alb',
    certificateArn: certArn,
    extras: {},
  },
});

const fixtureDoc = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-doc-database',
  component: 'fixture-doc',
  env: 'staging',
  strategy: 'database',
  construct: 'AwsDocumentDbCluster',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { engine: 'mongodb-compatible' },
    engine: 'mongodb-compatible',
  },
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

describe('DocumentToEcsStack', () => {
  it('injects portable DocumentDB secrets into Fargate task definitions', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureApi(), fixtureDoc()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
      projectName: 'demo',
    });
    const doc = app.node.findAll().find((node) => node instanceof DocDbStack);
    const ecs = app.node.findAll().find((node) => node instanceof EcsServiceStack);
    const edge = app.node.findAll().find((node) => node instanceof DocumentToEcsStack);
    expect(doc).toBeDefined();
    expect(ecs).toBeDefined();
    expect(edge).toBeDefined();
    expect((edge as DocumentToEcsStack).dependencies.some((dep) => dep === ecs)).toBe(true);

    const edgeTemplate = Template.fromStack(edge as DocumentToEcsStack);
    expect(Object.keys(edgeTemplate.findResources('AWS::EC2::SecurityGroupIngress')).length).toBeGreaterThan(0);

    const ecsTemplate = Template.fromStack(ecs as EcsServiceStack);
    const taskJson = JSON.stringify(ecsTemplate.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toMatch(/THONNAS_DOCUMENT_HOST/);
    expect(taskJson).toMatch(/THONNAS_DOCUMENT_PORT/);
    expect(taskJson).toMatch(/THONNAS_DOCUMENT_USERNAME/);
    expect(taskJson).toMatch(/THONNAS_DOCUMENT_PASSWORD/);
    expect(taskJson).toMatch(/THONNAS_DOCUMENT_TLS/);
    expect(taskJson).toMatch(/THONNAS_DOCUMENT_SECRET_ARN/);
    expect(taskJson).not.toMatch(/SECRET__DBT_MONGO/);
    expect(taskJson).not.toMatch(/tlsAllowInvalid/i);
  });

  it('keeps vendor product DSN mapping out of the edge source', () => {
    const src = fs.readFileSync(path.join(__dirname, 'document-to-ecs-stack.ts'), 'utf8');
    expect(src).not.toMatch(/SIGNOZ_|SECRET__DBT_MONGO|tlsAllowInvalid/i);
    expect(src).toMatch(/THONNAS_DOCUMENT_/);
  });

  it('does not invent DocumentToEcs when no Fargate peers exist', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureDoc()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    expect(app.node.findAll().some((node) => node instanceof DocumentToEcsStack)).toBe(false);
  });
});



