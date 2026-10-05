'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
} = require('@aws-sdk/client-secrets-manager');

// @intent Resolve region from env, then ~/.aws/config [default] so aws configure is enough
function resolveRegion() {
  if (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) {
    return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  }
  const configPath =
    process.env.AWS_CONFIG_FILE ||
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.aws', 'config');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const match = content.match(/(?:^|\n)\[default\]\s*\n(?:[^\[]*\n)*\s*region\s*=\s*(\S+)/);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// @intent Sanitize project key the same way DocDbStack / defaultManagedSecretName does
function projectPrefix() {
  const raw = (process.env.THONNAS_PROJECT_NAME || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/[^a-z0-9-_]/g, '').slice(0, 32);
}

// @intent Candidate SecretIds: full path, project-prefixed, then legacy shapes
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

async function getSecretByCandidates(client, candidates) {
  let lastError;
  for (const secretId of candidates) {
    try {
      const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (response.SecretString) {
        return parseSecretString(response.SecretString);
      }
      if (response.SecretBinary) {
        return Buffer.from(response.SecretBinary).toString('utf-8');
      }
    } catch (error) {
      lastError = error;
      if (error?.name !== 'ResourceNotFoundException' && process.env.CONFIG_THONNAS_DEBUG) {
        console.warn(`[aws-secrets-manager] Unable to read ${secretId}`, error);
      }
    }
  }
  if (lastError && process.env.CONFIG_THONNAS_DEBUG) {
    console.warn('[aws-secrets-manager] No candidate secret resolved', lastError);
  }
  return undefined;
}

// @intent Store/resolve beta+ secrets in AWS Secrets Manager using the host credential chain
const createSecretsProvider = () => {
  const region = resolveRegion();
  if (!region) {
    return createDisabledProvider();
  }

  const endpoint =
    process.env.AWS_SECRETS_MANAGER_ENDPOINT ||
    process.env.AWS_ENDPOINT_URL ||
    process.env.LOCALSTACK_ENDPOINT ||
    process.env.LOCALSTACK_URL ||
    undefined;
  const client = new SecretsManagerClient(
    endpoint
      ? {
          region,
          endpoint,
        }
      : { region },
  );
  return {
    id: 'aws-secrets-manager',
    priority: 100,
    supportsEnv: (env) => env !== 'development' && env !== 'local',
    async resolve(args) {
      return getSecretByCandidates(client, candidateSecretIds(args));
    },
    async store({ componentKey, secretName, env, value }) {
      const secretId = candidateSecretIds({ componentKey, secretName, env })[0];
      if (!secretId) throw new Error('aws-secrets-manager store requires componentKey, env, and secretName');
      await putSecret(client, secretId, value);
    },
    async delete({ componentKey, secretName, env }) {
      const secretId = candidateSecretIds({ componentKey, secretName, env })[0];
      if (!secretId) return;
      try {
        await client.send(
          new DeleteSecretCommand({
            SecretId: secretId,
            ForceDeleteWithoutRecovery: true,
          }),
        );
      } catch (error) {
        if (error?.name !== 'ResourceNotFoundException') throw error;
      }
    },
  };
};

const createDisabledProvider = () => ({
  id: 'aws-secrets-manager',
  priority: 100,
  supportsEnv: () => false,
  resolve: async () => undefined,
  activationHint(env) {
    if (env === 'development' || env === 'local') return undefined;
    return 'Run `aws configure` and set a default region, or export AWS_REGION (then retry).';
  },
});

const parseSecretString = (secretString) => {
  try {
    const parsed = JSON.parse(secretString);
    if (typeof parsed === 'string') {
      return parsed;
    }
    if (parsed && typeof parsed.value === 'string') {
      return parsed.value;
    }
    // @intent Return DocDB/RDS JSON so config resolve can map host/username/password fields
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // fall through
  }
  return secretString;
};

async function putSecret(client, secretId, value) {
  const secretString = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: secretString,
      }),
    );
  } catch (error) {
    if (error?.name === 'ResourceNotFoundException') {
      await client.send(
        new CreateSecretCommand({
          Name: secretId,
          SecretString: secretString,
        }),
      );
      return;
    }
    throw error;
  }
}

module.exports = {
  createSecretsProvider,
  candidateSecretIds,
};



