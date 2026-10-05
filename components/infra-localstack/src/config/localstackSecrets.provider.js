'use strict';

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEV_ENVS = new Set(['development', 'local']);
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_PORT = 4566;
const HEALTH_WAIT_MS = 60_000;
const HEALTH_POLL_MS = 1_000;

// @intent Same SecretId shapes as infra-cdk aws-secrets-manager so local matches AWS
function projectPrefix() {
  const raw = (process.env.THONNAS_PROJECT_NAME || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/[^a-z0-9-_]/g, '').slice(0, 32);
}

function candidateSecretIds({ componentKey, secretName, env }) {
  const name = String(secretName || '').trim();
  const component = String(componentKey || '').trim();
  const envKey = String(env || '').trim();
  const proj = projectPrefix();
  const out = [];
  const push = (id) => {
    if (id && !out.includes(id)) out.push(id);
  };
  if (name.includes('/')) {
    push(name);
    if (proj && !name.startsWith(`${proj}/`)) push(`${proj}/${name}`);
  } else {
    if (proj && envKey && component && name) push(`${proj}/${envKey}/${component}/${name}`);
    if (envKey && component && name) push(`${envKey}/${component}/${name}`);
    if (component && envKey && name) push(`${component}/${envKey}/${name}`);
  }
  return out;
}

function resolveRegion() {
  return (
    process.env.INFRA_LOCALSTACK_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    DEFAULT_REGION
  );
}

function resolveHostPort() {
  const raw = process.env.INFRA_LOCALSTACK_PORT;
  const port = raw ? Number(raw) : DEFAULT_PORT;
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

function resolveEndpoint() {
  const explicit =
    process.env.INFRA_LOCALSTACK_HOST_ENDPOINT ||
    process.env.AWS_SECRETS_MANAGER_ENDPOINT ||
    process.env.AWS_ENDPOINT_URL;
  if (explicit && !/infra-localstack|infra-cdk-localstack/.test(explicit)) {
    return explicit.replace(/\/$/, '');
  }
  return `http://127.0.0.1:${resolveHostPort()}`;
}

function parseSecretString(secretString) {
  try {
    const parsed = JSON.parse(secretString);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed.value === 'string') return parsed.value;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through
  }
  return secretString;
}

async function smSend(endpoint, target, body) {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `secretsmanager.${target}`,
      Authorization: 'AWS4-HMAC-SHA256 Credential=test/19700101/us-east-1/secretsmanager/aws4_request, SignedHeaders=host, Signature=local',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }
  if (!res.ok) {
    const type = String(json.__type || json.code || '').split('#').pop();
    const err = new Error(json.message || json.Message || text || `HTTP ${res.status}`);
    err.name = type || 'SecretsManagerError';
    throw err;
  }
  return json;
}

async function getSecretByCandidates(endpoint, candidates) {
  let lastError;
  for (const secretId of candidates) {
    try {
      const response = await smSend(endpoint, 'GetSecretValue', { SecretId: secretId });
      if (response.SecretString) return parseSecretString(response.SecretString);
      if (response.SecretBinary) {
        return Buffer.from(response.SecretBinary, 'base64').toString('utf-8');
      }
    } catch (error) {
      lastError = error;
      if (error?.name !== 'ResourceNotFoundException' && process.env.CONFIG_THONNAS_DEBUG) {
        console.warn(`[localstack-secrets-manager] Unable to read ${secretId}`, error);
      }
    }
  }
  if (lastError && process.env.CONFIG_THONNAS_DEBUG) {
    console.warn('[localstack-secrets-manager] No candidate secret resolved', lastError);
  }
  return undefined;
}

async function putSecret(endpoint, secretId, value) {
  const secretString = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    await smSend(endpoint, 'PutSecretValue', {
      SecretId: secretId,
      SecretString: secretString,
      ClientRequestToken: randomUUID(),
    });
  } catch (error) {
    if (error?.name === 'ResourceNotFoundException') {
      await smSend(endpoint, 'CreateSecret', {
        Name: secretId,
        SecretString: secretString,
        ClientRequestToken: randomUUID(),
      });
      return;
    }
    throw error;
  }
}

async function isHealthy(endpoint) {
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/_localstack/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function readProjectName(projectRoot) {
  if (process.env.THONNAS_PROJECT_NAME) return process.env.THONNAS_PROJECT_NAME;
  const configPath = path.join(projectRoot, 'project', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const fromConfig =
      config?.development?.THONNAS_PROJECT_NAME ||
      config?.default?.THONNAS_PROJECT_NAME ||
      config?.THONNAS_PROJECT_NAME;
    if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim();
  } catch {
    // fall through
  }
  const pkgPath = path.join(projectRoot, 'thonnas-package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch {
    // fall through
  }
  return path.basename(projectRoot);
}

function startLocalstack(projectRoot) {
  const projectName = readProjectName(projectRoot);
  const generatedEnv = path.join(
    projectRoot,
    'components',
    'infra-docker',
    'generated',
    '.env.localstack',
  );
  const componentOverride = path.join(
    'components',
    'infra-localstack',
    'docker-compose.override.yml',
  );
  const env = {
    ...process.env,
    INFRA_LOCALSTACK_SERVICES:
      process.env.INFRA_LOCALSTACK_SERVICES || 'secretsmanager,s3,sns,sqs',
  };
  spawnSync('docker', ['network', 'create', 'thonnas-network'], {
    cwd: projectRoot,
    stdio: 'ignore',
    windowsHide: true,
  });
  const args = ['compose', '-p', projectName];
  if (fs.existsSync(generatedEnv)) {
    args.push('--env-file', path.join('components', 'infra-docker', 'generated', '.env.localstack'));
  }
  args.push('-f', componentOverride, 'up', '-d');
  const result = spawnSync('docker', args, {
    cwd: projectRoot,
    env,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `[localstack-secrets-manager] Failed to start infra-localstack for project "${projectName}". ${detail}`,
    );
  }
}

async function ensureLocalstack(projectRoot, endpoint) {
  if (await isHealthy(endpoint)) return;
  startLocalstack(projectRoot);
  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(
    `[localstack-secrets-manager] LocalStack did not become healthy at ${endpoint}. Development secrets use Secrets Manager on @thonnas/infra-localstack.`,
  );
}

// @intent Development/local writable secret backend: LocalStack Secrets Manager (same API as AWS)
const createSecretsProvider = ({ projectRoot } = {}) => {
  const root = projectRoot || process.cwd();
  const endpoint = resolveEndpoint();
  const region = resolveRegion();
  void region;
  return {
    id: 'localstack-secrets-manager',
    priority: 250,
    supportsEnv: (env) => DEV_ENVS.has(env) || String(env || '').startsWith('feature/') || String(env || '').startsWith('ephemeral/'),
    activationHint(env) {
      if (DEV_ENVS.has(env)) return undefined;
      return 'Development secrets use @thonnas/infra-localstack (LocalStack Secrets Manager). Deployed envs use infra-cdk aws-secrets-manager.';
    },
    async resolve(args) {
      if (!(await isHealthy(endpoint))) return undefined;
      return getSecretByCandidates(endpoint, candidateSecretIds(args));
    },
    async store(args) {
      await ensureLocalstack(root, endpoint);
      const secretId = candidateSecretIds(args)[0];
      if (!secretId) {
        throw new Error('localstack-secrets-manager store requires componentKey, env, and secretName');
      }
      await putSecret(endpoint, secretId, args.value);
    },
    async delete(args) {
      if (!(await isHealthy(endpoint))) return;
      const secretId = candidateSecretIds(args)[0];
      if (!secretId) return;
      try {
        await smSend(endpoint, 'DeleteSecret', {
          SecretId: secretId,
          ForceDeleteWithoutRecovery: true,
        });
      } catch (error) {
        if (error?.name !== 'ResourceNotFoundException') throw error;
      }
    },
  };
};

module.exports = {
  createSecretsProvider,
  candidateSecretIds,
  resolveEndpoint,
  projectPrefix,
};

