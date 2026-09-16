import path from 'node:path';
import process from 'node:process';

export function sanitizedSmokeEnvironment(packageRoot, inheritedEnvironment = process.env) {
  const environment = { ...inheritedEnvironment };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('QLIK_') || key.startsWith('DOTENV_') || key === 'NODE_OPTIONS') {
      delete environment[key];
    }
  }
  return {
    ...environment,
    DOTENV_CONFIG_PATH: path.join(packageRoot, '.package-smoke-no-env'),
    QLIK_HARNESS_ACTOR: 'package-smoke-actor',
    QLIK_HARNESS_HOST_CLIENT_ID: 'package-smoke-client',
    QLIK_HARNESS_LOG_LEVEL: 'error',
    QLIK_HARNESS_TARGET_MODE: 'fixture',
  };
}
