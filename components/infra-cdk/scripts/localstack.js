#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('node:child_process');

const mode = process.argv[2] ?? 'start';
const containerName = process.env.THONNAS_LOCALSTACK_CONTAINER ?? 'infra-localstack';

const runDocker = (args, opts = {}) => {
  const result = spawnSync('docker', args, { stdio: 'inherit', env: process.env, ...opts });
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
};

switch (mode) {
  case 'start':
    console.error(
      'LocalStack is owned by @thonnas/infra-localstack. Use `thonnas start` (service infra-localstack). Do not start a second container from infra-cdk.',
    );
    process.exit(1);
    break;
  case 'stop':
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    console.log(`Stopped container ${containerName} if it was running. Prefer: thonnas stop`);
    break;
  case 'logs':
    runDocker(['logs', '-f', containerName]);
    break;
  default:
    console.error(`Unknown mode "${mode}". Use start|stop|logs.`);
    process.exit(1);
}



