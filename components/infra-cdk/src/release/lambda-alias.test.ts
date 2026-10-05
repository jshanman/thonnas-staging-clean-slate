import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  releaseLambdaAlias,
  resolveLambdaFunctionName,
  rollbackLambdaAlias,
  zipSingleFile,
  type LambdaAliasPort,
} from './lambda-alias';

function memoryPort(startVersion?: string) {
  let code: Buffer = Buffer.alloc(0);
  let latest = startVersion ?? '1';
  let aliasVersion = startVersion;
  let versions = 1;
  const port: LambdaAliasPort = {
    async updateFunctionCode(_name, zip) {
      code = Buffer.from(zip);
    },
    async waitFunctionUpdated() {
      /* memory port is already consistent */
    },
    async publishVersion() {
      versions += 1;
      latest = String(versions);
      return latest;
    },
    async updateAlias(_name, _alias, version) {
      aliasVersion = version;
    },
    async getAlias() {
      return aliasVersion ? { functionVersion: aliasVersion } : undefined;
    },
  };
  return { port, getCode: () => code, getAliasVersion: () => aliasVersion };
}

describe('lambda-alias release', () => {
  it('resolves functionName from extras then generated endpoints', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-name-'));
    fs.mkdirSync(path.join(dir, 'generated'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'generated', 'thonnas-config.generated.json'),
      JSON.stringify({ functionName: 'from-generated' }),
    );
    expect(
      resolveLambdaFunctionName({
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: { functionName: 'from-extras' },
      }),
    ).toBe('from-extras');
    expect(
      resolveLambdaFunctionName({
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: {},
      }),
    ).toBe('from-generated');
  });

  it('publishes a version and flips alias live', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-rel-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'handler.js'), 'exports.handler = async () => ({ body: "A" });');
    const { port, getAliasVersion } = memoryPort('1');
    const result = await releaseLambdaAlias(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: { functionName: 'staging-p3fn-signed-url', 'deploy.wait': false, handlerPath: 'src/handler.js' },
      },
      port,
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(result.binding).toBe('lambda-alias');
    expect(result.from).toBe('1');
    expect(result.to).toBe('2');
    expect(getAliasVersion()).toBe('2');
    expect(JSON.stringify(result)).not.toMatch(/RoutingConfig|AdditionalVersionWeights/);
    expect(result.message).toMatch(/version 2/);
  });

  it('rollback flips the alias to from without rebuilding', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-rb-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'handler.js'), 'exports.handler = async () => ({ body: "B" });');
    const { port, getAliasVersion } = memoryPort('2');
    const result = await rollbackLambdaAlias(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        restoreGenerationId: '1',
        extras: { functionName: 'staging-p3fn-signed-url', 'deploy.wait': false },
      },
      port,
    );
    expect(result.ok).toBe(true);
    expect(result.from).toBe('2');
    expect(result.to).toBe('1');
    expect(getAliasVersion()).toBe('1');
  });

  it('fail-closes when there is no previous version', async () => {
    const { port, getAliasVersion } = memoryPort('1');
    const result = await rollbackLambdaAlias(
      {
        projectRoot: '/tmp',
        env: 'staging',
        extras: { functionName: 'staging-p3fn-signed-url', 'deploy.wait': false },
      },
      port,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no previous version/);
    expect(getAliasVersion()).toBe('1');
  });

  it('fail-closes when the payload or function name is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-miss-'));
    const { port } = memoryPort();
    const noFn = await releaseLambdaAlias(
      { projectRoot: dir, env: 'staging', packageDir: dir, extras: { 'deploy.wait': false } },
      port,
    );
    expect(noFn.ok).toBe(false);
    expect(noFn.message).toMatch(/functionName/);
    const noFile = await releaseLambdaAlias(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: { functionName: 'x', handlerPath: 'src/handler.js', 'deploy.wait': false },
      },
      port,
    );
    expect(noFile.ok).toBe(false);
    expect(noFile.message).toMatch(/handlerPath/);
  });

  it('zips a single index.js without extra deps', () => {
    const zip = zipSingleFile('index.js', Buffer.from('exports.handler=async()=>({})'));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  });
});



