import fs from 'node:fs/promises';
import path from 'node:path';

const readFileIfExists = async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
};

// @intent Provide a secrets provider that reads local docker secrets for compose environments
export const createSecretsProvider = ({ projectRoot }) => {
  const secretsDir = path.join(
    projectRoot,
    'components',
    'infra-docker',
    'secrets',
  );

  return {
    id: 'docker-secrets',
    priority: 200,
    supportsEnv: (env) =>
      !env ||
      env === 'development' ||
      env === 'local' ||
      env.startsWith('feature/') ||
      env.startsWith('ephemeral/'),
    async resolve({ secretName, env }) {
      if (process.env[secretName]) {
        return process.env[secretName];
      }
      const fileEnv = process.env[`${secretName}_FILE`];
      if (fileEnv) {
        const value = await readFileIfExists(fileEnv);
        if (value) return value.trim();
      }
      const runPath = `/run/secrets/${secretName}`;
      const runSecret = await readFileIfExists(runPath);
      if (runSecret) {
        return runSecret.trim();
      }
      const scopedDir = path.join(secretsDir, env ?? 'development');
      const scopedSecret = await readFileIfExists(path.join(scopedDir, secretName));
      if (scopedSecret) {
        return scopedSecret.trim();
      }
      const localSecret = await readFileIfExists(path.join(secretsDir, secretName));
      return localSecret?.trim();
    },
    async store({ secretName, env, value }) {
      const scopedDir = path.join(secretsDir, env ?? 'development');
      await fs.mkdir(scopedDir, { recursive: true });
      const filePath = path.join(scopedDir, secretName);
      await fs.writeFile(filePath, `${value}\n`, 'utf-8');
    },
    async delete({ secretName, env }) {
      const scopedDir = path.join(secretsDir, env ?? 'development');
      const filePath = path.join(scopedDir, secretName);
      try {
        await fs.unlink(filePath);
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
      }
      const unscopedPath = path.join(secretsDir, secretName);
      try {
        await fs.unlink(unscopedPath);
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
      }
    },
  };
};


