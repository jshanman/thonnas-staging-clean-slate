import { describe, expect, it } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildComposeHostUserData } from './compose-host-stack';

const execFileAsync = promisify(execFile);

const commandExists = async (cmd: string): Promise<boolean> => {
  try {
    await execFileAsync(cmd, ['--version']);
    return true;
  } catch {
    return false;
  }
};

// @intent Skip dockerized tests when the CLI exists but the daemon is down
const dockerDaemonAvailable = async (): Promise<boolean> => {
  try {
    await execFileAsync('docker', ['info']);
    return true;
  } catch {
    return false;
  }
};

const run = async (cmd: string, args: string[], options?: Record<string, unknown>): Promise<void> => {
  await execFileAsync(cmd, args, options);
};

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

interface BranchOverrideConfig {
  name: string;
  filePath: string;
  contents: string;
}

// @intent Seed a bare git repo with main branch and optional feature branch
const seedBareRepo = async (baseDir: string, branchOverride?: BranchOverrideConfig): Promise<string> => {
  const sourceDir = path.join(baseDir, 'source');
  await run('git', ['init', sourceDir]);
  await run('git', ['-C', sourceDir, 'config', 'user.email', 'ci@example.com']);
  await run('git', ['-C', sourceDir, 'config', 'user.name', 'CI Bot']);
  await writeFile(path.join(sourceDir, 'README.md'), '# compose-host-test\n', 'utf8');
  await run('git', ['-C', sourceDir, 'add', 'README.md']);
  await run('git', ['-C', sourceDir, 'commit', '-m', 'init']);
  await run('git', ['-C', sourceDir, 'branch', '-M', 'main']);

  if (branchOverride) {
    await run('git', ['-C', sourceDir, 'checkout', '-b', branchOverride.name]);
    await writeFile(path.join(sourceDir, branchOverride.filePath), branchOverride.contents, 'utf8');
    await run('git', ['-C', sourceDir, 'add', branchOverride.filePath]);
    await run('git', ['-C', sourceDir, 'commit', '-m', `add ${branchOverride.filePath}`]);
    await run('git', ['-C', sourceDir, 'checkout', 'main']);
  }

  const bareRepoDir = path.join(baseDir, 'repo.git');
  await run('git', ['clone', '--bare', sourceDir, bareRepoDir]);
  return bareRepoDir;
};

describe('compose host user data integration', () => {
  it(
    'clones a repository via dockerized user-data script',
    async () => {
      const hasDocker = (await commandExists('docker')) && (await dockerDaemonAvailable());
      const hasGit = await commandExists('git');

      if (!hasDocker || !hasGit) {
        // eslint-disable-next-line no-console
        console.warn('Skipping compose host integration test (docker or git missing)');
        return;
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'compose-host-test-'));
      await seedBareRepo(tempDir);
      const outputDir = path.join(tempDir, 'output');
      const composeFile = path.join(tempDir, 'docker-compose.yml');
      const scriptPath = path.join(tempDir, 'run-user-data.sh');

      try {
        await writeFile(
          composeFile,
          'services:\n  noop:\n    image: public.ecr.aws/docker/library/busybox:latest\n    command: ["sh","-c","sleep 1"]\n',
          'utf8',
        );

        const envLines = ['THONNAS_ENV=beta', 'API_HOST=beta.api.local'];
        const userDataCommands = buildComposeHostUserData({
          workingDirectory: '/workspace/output',
          gitRepositoryUrl: 'file:///workspace/repo.git',
          composeFile: '/workspace/docker-compose.yml',
          tag: 'main',
          envFileLines: envLines,
          gitPasswordSecretName: 'TEST_PROJECT_GIT_PWD',
        });

        const scriptContent = [
          '#!/bin/bash',
          'set -euo pipefail',
          'export SKIP_DOCKER_CMDS=true',
          'export GIT_PASSWORD=test-token',
          ...userDataCommands,
        ].join('\n');

        await writeFile(scriptPath, scriptContent, { mode: 0o755 });

        const resolvedTempDir = path.resolve(tempDir);
        const volumePath =
          process.platform === 'win32'
            ? resolvedTempDir
                .replace(/\\/g, '/')
                .replace(/^([A-Za-z]):\//, (_, drive: string) => `${drive.toUpperCase()}:/`)
            : resolvedTempDir;

        await run(
          'docker',
          ['run', '--rm', '-v', `${volumePath}:/workspace`, 'amazonlinux:2023', '/workspace/run-user-data.sh'],
          { stdio: 'inherit' },
        );

        const envFile = await readFile(path.join(outputDir, '.env.thonnas'), 'utf8');
        expect(envFile).toContain('THONNAS_ENV=beta');
        expect(await fileExists(path.join(outputDir, '.git', 'config'))).toBe(true);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    'clones the requested branch when tag override is provided',
    async () => {
      const hasDocker = (await commandExists('docker')) && (await dockerDaemonAvailable());
      const hasGit = await commandExists('git');

      if (!hasDocker || !hasGit) {
        // eslint-disable-next-line no-console
        console.warn('Skipping compose host integration test (docker or git missing)');
        return;
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'compose-host-branch-test-'));
      const branchName = 'feature/feat-009';
      const featureFile = 'feature.txt';
      await seedBareRepo(tempDir, {
        name: branchName,
        filePath: featureFile,
        contents: 'branch-specific content',
      });
      const outputDir = path.join(tempDir, 'output');
      const composeFile = path.join(tempDir, 'docker-compose.yml');
      const scriptPath = path.join(tempDir, 'run-branch-user-data.sh');

      try {
        await writeFile(
          composeFile,
          'services:\n  noop:\n    image: public.ecr.aws/docker/library/busybox:latest\n    command: ["sh","-c","sleep 1"]\n',
          'utf8',
        );

        const envLines = ['THONNAS_ENV=beta', 'API_HOST=beta.api.local'];
        const userDataCommands = buildComposeHostUserData({
          workingDirectory: '/workspace/output',
          gitRepositoryUrl: 'file:///workspace/repo.git',
          composeFile: '/workspace/docker-compose.yml',
          tag: branchName,
          envFileLines: envLines,
          gitPasswordSecretName: 'TEST_PROJECT_GIT_PWD',
        });

        const scriptContent = [
          '#!/bin/bash',
          'set -euo pipefail',
          'export SKIP_DOCKER_CMDS=true',
          'export GIT_PASSWORD=test-token',
          ...userDataCommands,
        ].join('\n');

        await writeFile(scriptPath, scriptContent, { mode: 0o755 });

        const resolvedTempDir = path.resolve(tempDir);
        const volumePath =
          process.platform === 'win32'
            ? resolvedTempDir
                .replace(/\\/g, '/')
                .replace(/^([A-Za-z]):\//, (_, drive: string) => `${drive.toLowerCase()}:/`)
            : resolvedTempDir;

        await run('docker', ['run', '--rm', '-v', `${volumePath}:/workspace`, 'amazonlinux:2023', '/workspace/run-branch-user-data.sh'], {
          stdio: 'inherit',
        });

        const envFile = await readFile(path.join(outputDir, '.env.thonnas'), 'utf8');
        expect(envFile).toContain('THONNAS_ENV=beta');

        const branchHead = await execFileAsync('git', ['-C', outputDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
        expect(branchHead.stdout.trim()).toBe(branchName);

        const featureContent = await readFile(path.join(outputDir, featureFile), 'utf8');
        expect(featureContent.trim()).toBe('branch-specific content');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});




