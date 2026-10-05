#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const mode = process.argv[2] ?? 'shell';
const repoRoot = path.resolve(path.join(__dirname, '../../..'));
const image = process.env.THONNAS_INFRA_IMAGE ?? 'thonnas/infra-cdk:latest';
const awsVolume = process.env.THONNAS_INFRA_AWS_VOLUME ?? 'thonnas-infra-aws-config';
const awsCli = process.env.THONNAS_AWS_CLI ?? 'aws';
const workspaceDir = '/workspace';
const projectName = (() => {
  try {
    const pkg = require(path.join(repoRoot, 'thonnas-package.json'));
    return pkg.name || 'thonnas-project';
  } catch {
    return 'thonnas-project';
  }
})();
const sanitizedProject = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
const containerName =
  process.env.THONNAS_INFRA_CONTAINER ?? `${sanitizedProject || 'thonnas-project'}-infra-cdk`;
const composeProjectLabel =
  process.env.THONNAS_INFRA_DOCKER_PROJECT ?? (sanitizedProject || 'thonnas-project');
const composeServiceLabel = process.env.THONNAS_INFRA_DOCKER_SERVICE ?? 'infra-cdk';

const ensureDockerAvailable = () => {
  const result = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  if (result.error) {
    console.error('Docker CLI is required but was not found on PATH.');
    process.exit(1);
  }
};

const ensureImageExists = () => {
  const inspect = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  if (inspect.status !== 0) {
    console.error(`Docker image "${image}" not found. Run "npm run infra:docker-build" first.`);
    process.exit(1);
  }
};

const runContainer = (containerArgs) => {
  const baseArgs = [
    'run',
    '--rm',
    '-it',
    '--name',
    containerName,
    '--label',
    `com.docker.compose.project=${composeProjectLabel}`,
    '--label',
    `com.docker.compose.service=${composeServiceLabel}`,
    '-v',
    `${repoRoot}:${workspaceDir}`,
    '-v',
    `${awsVolume}:/root/.aws`,
    '-w',
    workspaceDir,
  ];

  const result = spawnSync('docker', [...baseArgs, ...containerArgs], {
    stdio: 'inherit',
    env: process.env,
  });

  process.exit(result.status ?? 0);
};

const run = () => {
  ensureDockerAvailable();
  ensureImageExists();

  if (mode === 'aws-config') {
    console.log(`Opening ${awsCli} configure session inside container (stored in volume:`, awsVolume, ')');
    runContainer([image, awsCli, 'configure']);
    return;
  }

  if (mode === 'aws-config-list') {
    runContainer([image, awsCli, 'configure', 'list']);
    return;
  }

  console.log('Starting interactive infra shell...');
  runContainer([image, '/bin/bash']);
};

run();




