// @intent Define interface for secrets provider implementations
export interface SecretsProvider {
  getSecret(path: string): Promise<string | undefined>;
  setSecret(path: string, value: string): Promise<void>;
  ensureSecret(path: string, generator?: () => string): Promise<string>;
}

export interface SecretsProviderFactoryOptions {
  projectRoot: string;
  env: string;
}




