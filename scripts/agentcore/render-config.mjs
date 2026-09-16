#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Checkouts validate current source; packaged deployments contain built dist and no dev loader.
// Never use a stale checkout build to validate the policy being rendered for a new build.
const loadSource = existsSync(path.join(projectRoot, 'src/management/policy.ts'))
  ? (await import('tsx/esm/api')).tsImport
  : undefined;
const loadManagementModule = (name) =>
  loadSource
    ? loadSource(`../../src/management/${name}.ts`, import.meta.url)
    : import(
        /* @vite-ignore */ pathToFileURL(path.join(projectRoot, 'dist/management', `${name}.js`))
          .href
      );
const [
  { managementPolicySchema },
  { REST_ACTION_SCHEMAS, REST_READ_ACTIONS },
  { ENGINE_ACTION_SCHEMAS, ENGINE_MUTATION_ACTIONS },
] = await Promise.all([
  loadManagementModule('policy'),
  loadManagementModule('restContracts'),
  loadManagementModule('cloudEngineProvider'),
]);
const MANAGEMENT_ACTIONS = new Set([
  ...Object.keys(REST_ACTION_SCHEMAS),
  ...Object.keys(ENGINE_ACTION_SCHEMAS),
  'data.profile',
  'data.prepare',
  'script.apply',
  'reload.wait',
  'artifact.read',
]);
const MANAGEMENT_READ_ACTIONS = new Set([
  ...REST_READ_ACTIONS,
  ...Object.keys(ENGINE_ACTION_SCHEMAS).filter((action) => !ENGINE_MUTATION_ACTIONS.has(action)),
  'data.profile',
  'data.prepare',
  'reload.wait',
  'artifact.read',
]);
const TARGETLESS_ACTIONS = new Set([
  'space.list',
  'space.create',
  'datafile.quotas',
  'data.profile',
]);
const CHART_TYPES = ['bar', 'line', 'scatter', 'table', 'kpi', 'gauge', 'treemap', 'pie', 'combo'];
const AGENTCORE_REGIONS = new Set([
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-5',
  'ap-southeast-7',
  'ca-central-1',
  'eu-central-1',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-gov-west-1',
  'us-west-2',
]);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function strings(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  const entries = value.map((entry, index) => string(entry, `${name}[${index}]`));
  if (new Set(entries).size !== entries.length)
    throw new Error(`${name} must not contain duplicates.`);
  return entries;
}

function csvStrings(value, name) {
  const entries = strings(value, name);
  if (
    entries.some((entry) =>
      Array.from(entry).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return character === ',' || codePoint < 32 || codePoint === 127;
      }),
    )
  ) {
    throw new Error(`${name} entries must not contain commas or control characters.`);
  }
  return entries;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean.`);
  return value;
}

function httpsUrl(value, name, suffix) {
  const raw = string(value, name);
  const parsed = new URL(raw);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  if (suffix && !parsed.pathname.endsWith(suffix)) {
    throw new Error(`${name} must end with ${suffix}.`);
  }
  return raw.replace(/\/$/, '');
}

function httpsOrigin(value, name) {
  const raw = httpsUrl(value, name);
  const parsed = new URL(raw);
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`${name} must be an HTTPS origin without a path.`);
  }
  return parsed.origin;
}

function env(name, value) {
  return { name, value: String(value) };
}

function assertNoSecretFields(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (/secretvalue|clientsecret|password|privatekey|accesstoken|refreshtoken/i.test(key)) {
      throw new Error(
        `Secret material is forbidden in deployment configuration (${location}.${key}).`,
      );
    }
    assertNoSecretFields(entry, `${location}.${key}`);
  }
}

function deploymentManagementPolicy(input, scope) {
  if (input === undefined) return undefined;
  const parsed = managementPolicySchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'root'))];
    throw new Error(`managementPolicy does not match the runtime schema (${fields.join(', ')}).`);
  }
  const policy = parsed.data;
  const expectedEnvironment = scope.environment === 'nonproduction' ? 'test' : scope.environment;
  if (policy.enabled && policy.environment !== expectedEnvironment)
    throw new Error(
      'managementPolicy.environment must match qlikCloud.environment (nonproduction maps to test).',
    );
  if (policy.enabled && scope.environment === 'production' && !policy.allowProduction)
    throw new Error('Enabled production managementPolicy requires allowProduction=true.');
  if (policy.enabled && policy.grants.length === 0)
    throw new Error('Enabled managementPolicy requires at least one exact operator grant.');
  const reviewers = new Set();
  for (const reviewer of policy.reviewers) {
    if (
      !scope.reviewerActors.includes(reviewer.actor) ||
      !scope.allowedClients.includes(reviewer.clientId)
    )
      throw new Error(
        'managementPolicy reviewer actor and clientId must match the deployment reviewer and OIDC allowlists.',
      );
    const key = JSON.stringify([reviewer.actor, reviewer.clientId]);
    if (reviewers.has(key)) throw new Error('managementPolicy contains a duplicate reviewer.');
    reviewers.add(key);
  }
  const operations = new Set();
  for (const grant of policy.grants) {
    if (
      !scope.mutationActors.includes(grant.actor) ||
      !scope.allowedClients.includes(grant.clientId) ||
      grant.connection !== scope.connectionAlias
    )
      throw new Error(
        'managementPolicy operator actor, clientId and connection must exactly match the deployment requester/OIDC allowlists and Qlik connection.',
      );
    if (policy.enabled && Date.parse(grant.expiresAt) <= Date.now())
      throw new Error('Enabled managementPolicy operator grants must have a future expiresAt.');
    for (const [field, values] of Object.entries({
      actions: grant.actions,
      appIds: grant.appIds,
      spaceIds: grant.spaceIds,
    })) {
      if (new Set(values).size !== values.length)
        throw new Error(`managementPolicy ${field} must not contain duplicates.`);
      if (
        values.some(
          (value) =>
            /[*?]/.test(value) ||
            Array.from(value).some(
              (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
            ),
        )
      )
        throw new Error(
          `managementPolicy ${field} requires exact values without wildcard or control characters.`,
        );
    }
    if (grant.actions.some((action) => !MANAGEMENT_ACTIONS.has(action)))
      throw new Error('managementPolicy contains an unknown management action.');
    if (
      !grant.appIds.length &&
      !grant.spaceIds.length &&
      !grant.allowPersonalSpace &&
      grant.actions.some((action) => !TARGETLESS_ACTIONS.has(action))
    )
      throw new Error(
        'managementPolicy resource actions require exact appIds, spaceIds, or an explicit allowPersonalSpace grant.',
      );
    if (
      grant.actions.some((action) =>
        ['app.create', 'app.duplicate', 'app.move', 'datafile.upload', 'datafile.list'].includes(
          action,
        ),
      ) &&
      !grant.spaceIds.length &&
      !grant.allowPersonalSpace
    )
      throw new Error(
        'managementPolicy creation and destination actions require exact spaceIds or allowPersonalSpace.',
      );
    if (
      grant.actions.some(
        (action) =>
          action === 'app.publish' ||
          (action.startsWith('space.') && !TARGETLESS_ACTIONS.has(action)),
      ) &&
      !grant.spaceIds.length
    )
      throw new Error(
        'managementPolicy publishing and space access actions require exact spaceIds.',
      );
    if (
      policy.enabled &&
      grant.requireApproval &&
      grant.actions.some((action) => !MANAGEMENT_READ_ACTIONS.has(action)) &&
      policy.reviewers.length === 0
    )
      throw new Error(
        'Approval-required managementPolicy writes require a separately allowlisted reviewer.',
      );
    for (const action of grant.actions) {
      const key = JSON.stringify([grant.actor, grant.clientId, grant.connection, action]);
      if (operations.has(key))
        throw new Error(
          'managementPolicy contains overlapping operator grants for the same actor, clientId, connection and action.',
        );
      operations.add(key);
    }
  }
  return policy;
}

export function renderAgentCoreConfig(input) {
  assertNoSecretFields(input);
  const root = object(input, 'deployment configuration');
  const oidc = object(root.oidc, 'oidc');
  const governance = object(root.governance, 'governance');
  const qlik = object(root.qlikCloud, 'qlikCloud');
  const readiness = object(qlik.readiness, 'qlikCloud.readiness');
  const projectName = string(root.projectName, 'projectName');
  const runtimeName = string(root.runtimeName, 'runtimeName');
  if (!/^[A-Za-z][A-Za-z0-9]{0,22}$/.test(projectName)) {
    throw new Error('projectName must start with a letter and contain at most 23 alphanumerics.');
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(runtimeName)) {
    throw new Error('runtimeName must satisfy the AgentCore runtime-name contract.');
  }
  const executionRoleArn = string(root.executionRoleArn, 'executionRoleArn');
  if (!/^arn:[a-z0-9-]+:iam::\d{12}:role\/.+/.test(executionRoleArn)) {
    throw new Error('executionRoleArn must be an IAM role ARN.');
  }
  const discoveryUrl = httpsUrl(
    oidc.discoveryUrl,
    'oidc.discoveryUrl',
    '/.well-known/openid-configuration',
  );
  const allowedClients = csvStrings(oidc.allowedClients, 'oidc.allowedClients');
  const allowedScopes = csvStrings(oidc.allowedScopes, 'oidc.allowedScopes');
  if (allowedScopes.length !== 1) {
    throw new Error('oidc.allowedScopes must contain exactly one Runtime invocation scope.');
  }
  const mutationActors = csvStrings(governance.mutationActors, 'governance.mutationActors');
  // An explicitly empty list is evaluated after the complete management policy is validated.
  const reviewerActors =
    Array.isArray(governance.reviewerActors) && governance.reviewerActors.length === 0
      ? []
      : csvStrings(governance.reviewerActors, 'governance.reviewerActors');
  if (mutationActors.some((actor) => reviewerActors.includes(actor))) {
    throw new Error('Requester and reviewer subject allowlists must not overlap.');
  }
  const environment = string(qlik.environment, 'qlikCloud.environment').toLowerCase();
  if (!['development', 'nonproduction', 'production'].includes(environment)) {
    throw new Error('qlikCloud.environment must be development, nonproduction, or production.');
  }
  const connectionAlias = string(qlik.connectionAlias, 'qlikCloud.connectionAlias');
  const managementPolicy = deploymentManagementPolicy(root.managementPolicy, {
    environment,
    connectionAlias,
    allowedClients,
    mutationActors,
    reviewerActors,
  });
  if (
    reviewerActors.length === 0 &&
    !(
      managementPolicy?.enabled === true &&
      managementPolicy.reviewers.length === 0 &&
      managementPolicy.grants.length > 0 &&
      managementPolicy.grants.every((grant) => grant.requireApproval === false)
    )
  ) {
    throw new Error(
      'governance.reviewerActors must be non-empty unless an enabled managementPolicy explicitly waives approval for every grant and has no reviewers.',
    );
  }
  const tenantHost = httpsOrigin(qlik.tenantHost, 'qlikCloud.tenantHost');
  const appId = string(qlik.appId, 'qlikCloud.appId');
  const sheetId = string(qlik.sheetId, 'qlikCloud.sheetId');
  let sheetGeneration;
  if (qlik.sheetGeneration !== undefined) {
    const grant = object(qlik.sheetGeneration, 'qlikCloud.sheetGeneration');
    const keys = ['actors', 'appIds', 'chartTypes', 'maxCharts', 'allowProduction'];
    if (Object.keys(grant).some((key) => !keys.includes(key))) {
      throw new Error('qlikCloud.sheetGeneration contains an unknown grant field.');
    }
    const actors = csvStrings(grant.actors, 'qlikCloud.sheetGeneration.actors');
    const appIds = strings(grant.appIds, 'qlikCloud.sheetGeneration.appIds');
    const chartTypes = strings(grant.chartTypes, 'qlikCloud.sheetGeneration.chartTypes');
    if (
      actors.some((actor) => !mutationActors.includes(actor)) ||
      appIds.some((id) => id !== appId) ||
      chartTypes.some((type) => !CHART_TYPES.includes(type)) ||
      !Number.isInteger(grant.maxCharts) ||
      grant.maxCharts < 1 ||
      grant.maxCharts > 12
    ) {
      throw new Error(
        'Sheet generation must use allowlisted mutation actors, the configured app, supported chart types and maxCharts 1-12.',
      );
    }
    sheetGeneration = {
      actors,
      appIds,
      chartTypes,
      maxCharts: grant.maxCharts,
      allowProduction: boolean(grant.allowProduction, 'qlikCloud.sheetGeneration.allowProduction'),
    };
  }
  if (
    environment === 'production' &&
    !sheetGeneration?.allowProduction &&
    !(managementPolicy?.enabled && managementPolicy.allowProduction)
  ) {
    throw new Error(
      'Production requires an explicit sheetGeneration grant or enabled managementPolicy with allowProduction=true.',
    );
  }
  const readinessValues = {
    approved: boolean(readiness.approved, 'qlikCloud.readiness.approved'),
    canRead: boolean(readiness.canRead, 'qlikCloud.readiness.canRead'),
    canPreview: boolean(readiness.canPreview, 'qlikCloud.readiness.canPreview'),
    canWriteDesignatedSheet: boolean(
      readiness.canWriteDesignatedSheet,
      'qlikCloud.readiness.canWriteDesignatedSheet',
    ),
    cleanupVerified: boolean(readiness.cleanupVerified, 'qlikCloud.readiness.cleanupVerified'),
  };
  const readinessExpiry = string(readiness.expiresAt, 'qlikCloud.readiness.expiresAt');
  if (Number.isNaN(Date.parse(readinessExpiry))) {
    throw new Error('qlikCloud.readiness.expiresAt must be an ISO timestamp.');
  }
  if (Object.values(readinessValues).some(Boolean) && Date.parse(readinessExpiry) <= Date.now()) {
    throw new Error('Enabled readiness evidence must have a future expiry.');
  }
  const policy = {
    allowedEnvironments: [environment],
    connections: [
      {
        alias: connectionAlias,
        platform: 'qlik-cloud',
        visualizationSchemaProfile: 'qlik-cloud-current',
        environment,
        productionUse: environment === 'production',
        ...(sheetGeneration ? { sheetGeneration } : {}),
        allowedApps: { [appId]: [sheetId] },
        allowedChartTypes: CHART_TYPES,
      },
    ],
  };

  return {
    $schema: 'https://schema.agentcore.aws.dev/v1/agentcore.json',
    name: projectName,
    version: 1,
    managedBy: 'CDK',
    runtimes: [
      {
        name: runtimeName,
        description: 'Governed Qlik MCP server with durable independent approval state.',
        build: 'Container',
        entrypoint: 'dist/agentcore/runtime.js',
        codeLocation: '.',
        dockerfile: 'Dockerfile',
        buildContextPath: '.',
        runtimeVersion: 'NODE_22',
        protocol: 'MCP',
        networkMode: 'PUBLIC',
        instrumentation: { enableOtel: false },
        requestHeaderAllowlist: [
          'Authorization',
          'X-Correlation-Id',
          'Mcp-Protocol-Version',
          'Mcp-Method',
          'Mcp-Name',
        ],
        executionRoleArn,
        authorizerType: 'CUSTOM_JWT',
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl,
            allowedAudience: [string(oidc.audience, 'oidc.audience')],
            allowedClients,
            allowedScopes,
          },
        },
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: 900,
          maxLifetime: 28800,
        },
        envVars: [
          env('NODE_ENV', 'production'),
          env('QLIK_HARNESS_LOG_LEVEL', 'info'),
          env('QLIK_AGENTCORE_REQUESTS_PER_MINUTE', 60),
          env('QLIK_HARNESS_MCP_ROLE', 'all'),
          env('QLIK_HARNESS_TARGET_MODE', 'cloud'),
          env('QLIK_HARNESS_CONNECTIONS_JSON', JSON.stringify(policy)),
          ...(managementPolicy
            ? [env('QLIK_MANAGEMENT_POLICY_JSON', JSON.stringify(managementPolicy))]
            : []),
          env('QLIK_HARNESS_MUTATION_ACTORS', mutationActors.join(',')),
          env('QLIK_HARNESS_REVIEWER_ACTORS', reviewerActors.join(',')),
          env('QLIK_AGENTCORE_STATE_TABLE', string(root.stateTableName, 'stateTableName')),
          env('QLIK_AGENTCORE_QLIK_SECRET_ID', string(root.qlikSecretId, 'qlikSecretId')),
          env('QLIK_AGENTCORE_JWT_DISCOVERY_URL', discoveryUrl),
          env('QLIK_AGENTCORE_JWT_AUDIENCE', string(oidc.audience, 'oidc.audience')),
          env('QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS', allowedClients.join(',')),
          env('QLIK_AGENTCORE_JWT_REQUIRED_SCOPES', allowedScopes.join(',')),
          env('QLIK_CLOUD_CONNECTION_ALIAS', connectionAlias),
          env('QLIK_CLOUD_TENANT_HOST', tenantHost),
          env('QLIK_CLOUD_TENANT_ALIAS', string(qlik.tenantAlias, 'qlikCloud.tenantAlias')),
          env('QLIK_CLOUD_REGION_ALIAS', string(qlik.regionAlias, 'qlikCloud.regionAlias')),
          env('QLIK_CLOUD_OAUTH_CLIENT_ID', string(qlik.oauthClientId, 'qlikCloud.oauthClientId')),
          env('QLIK_CLOUD_ENVIRONMENT', environment),
          env('QLIK_CLOUD_WRITE_APP_ID', appId),
          env('QLIK_CLOUD_WRITE_SHEET_ID', sheetId),
          ...(sheetGeneration
            ? [env('QLIK_CLOUD_SHEET_CREATION_APP_IDS', sheetGeneration.appIds.join(','))]
            : []),
          env('QLIK_CLOUD_READINESS_APPROVED', readinessValues.approved),
          env('QLIK_CLOUD_READINESS_EXPIRES_AT', readinessExpiry),
          env('QLIK_CLOUD_READINESS_CAN_READ', readinessValues.canRead),
          env('QLIK_CLOUD_READINESS_CAN_PREVIEW', readinessValues.canPreview),
          env(
            'QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET',
            readinessValues.canWriteDesignatedSheet,
          ),
          env('QLIK_CLOUD_READINESS_CLEANUP_VERIFIED', readinessValues.cleanupVerified),
        ],
      },
    ],
    memories: [],
    knowledgeBases: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    configBundles: [],
    abTests: [],
    harnesses: [],
  };
}

export function renderAwsTargets(input) {
  const root = object(input, 'deployment configuration');
  const target = object(root.awsTarget, 'awsTarget');
  const name = string(target.name, 'awsTarget.name');
  const account = string(target.account, 'awsTarget.account');
  const region = string(target.region, 'awsTarget.region');
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) {
    throw new Error('awsTarget.name must satisfy the AgentCore target-name contract.');
  }
  if (!/^\d{12}$/.test(account)) {
    throw new Error('awsTarget.account must be a 12-digit account ID.');
  }
  if (!AGENTCORE_REGIONS.has(region)) {
    throw new Error('awsTarget.region is not supported by this AgentCore CLI version.');
  }
  return [{ name, account, region }];
}

function main() {
  const inputPath = path.resolve(
    projectRoot,
    argument('--input', 'config/agentcore-deployment.json'),
  );
  const outputPath = path.resolve(projectRoot, argument('--output', 'agentcore/agentcore.json'));
  const targetsOutputPath = path.resolve(
    projectRoot,
    argument('--targets-output', 'agentcore/aws-targets.json'),
  );
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const rendered = renderAgentCoreConfig(input);
  const targets = renderAwsTargets(input);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(rendered, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(targetsOutputPath, `${JSON.stringify(targets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  chmodSync(targetsOutputPath, 0o600);
  process.stderr.write(
    `[agentcore] wrote non-secret runtime configuration to ${outputPath} and ${targetsOutputPath}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
