import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';

interface ExampleConnection {
  readonly alias: string;
  readonly allowedApps: Readonly<Record<string, readonly string[]>>;
  readonly visualizationSchemaProfile: string;
}

interface ConnectionsExample {
  readonly nonProductionOnly: boolean;
  readonly readinessStatus: string;
  readonly connections: readonly ExampleConnection[];
}

interface AgentCoreDeploymentExample {
  readonly executionRoleArn: string;
  readonly stateTableName: string;
  readonly qlikSecretId: string;
  readonly awsTarget: { readonly account: string; readonly region: string };
  readonly governance: {
    readonly mutationActors: readonly string[];
    readonly reviewerActors: readonly string[];
  };
  readonly qlikCloud: {
    readonly connectionAlias: string;
    readonly tenantHost: string;
    readonly appId: string;
    readonly sheetId: string;
    readonly readiness: Readonly<Record<string, boolean | string>>;
  };
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(relativePath), 'utf8')) as T;
}

const connections = readJson<ConnectionsExample>('config/connections.example.json');
const deployment = readJson<AgentCoreDeploymentExample>('config/agentcore-deployment.example.json');
const environment = parse(readFileSync(resolve('.env.example')));
const foundation = readFileSync(resolve('infra/aws/foundation.yaml'), 'utf8');

function connection(alias: string): ExampleConnection {
  const result = connections.connections.find((entry) => entry.alias === alias);
  if (!result) throw new Error(`Missing example connection ${alias}.`);
  return result;
}

describe('checked-in AgentCore configuration examples', () => {
  it('keeps the local fixture safe and preserves the canonical Cloud IDs', () => {
    const cloud = connection('cloud-dev');
    expect(cloud.allowedApps).toEqual({
      'app-sales-cloud-dev': ['sheet-sales-overview-cloud-dev'],
    });
    expect(cloud.visualizationSchemaProfile).toBe('qlik-cloud-current');
    expect(environment.QLIK_HARNESS_TARGET_MODE).toBe('fixture');
    expect(environment.QLIK_HARNESS_MUTATION_ACTORS).toBe('');
    expect(environment.QLIK_HARNESS_REVIEWER_ACTORS).toBe('');
    expect(environment.QLIK_CLOUD_OAUTH_CLIENT_SECRET).toBe('');
  });

  it('provides a non-secret, non-production AgentCore deployment shape', () => {
    expect(connections.nonProductionOnly).toBe(true);
    expect(connections.readinessStatus).toBe('blocked-until-platform-admin-evidence');
    expect(deployment.qlikCloud.connectionAlias).toBe('cloud-dev');
    expect(deployment.qlikCloud.tenantHost).toMatch(/^https:\/\//u);
    expect(deployment.qlikCloud.readiness).toMatchObject({
      approved: false,
      canRead: false,
      canPreview: false,
      canWriteDesignatedSheet: false,
      cleanupVerified: false,
    });
    expect(deployment.governance.mutationActors).not.toEqual(deployment.governance.reviewerActors);
    expect(deployment.executionRoleArn).toMatch(/^arn:aws:iam::\d{12}:role\//u);
    expect(deployment.stateTableName).toMatch(/agentcore-dev$/u);
    expect(deployment.qlikSecretId).toMatch(/^\/qlik-ai-harness\/agentcore\/dev\//u);
    expect(JSON.stringify(deployment)).not.toMatch(/clientSecret|secretValue|accessToken/u);
  });

  it('pins the foundation state and secret resources to recoverable AWS services', () => {
    expect(foundation).toContain('Type: AWS::DynamoDB::Table');
    expect(foundation).toContain('PointInTimeRecoveryEnabled: true');
    expect(foundation).toContain('AttributeName: expiresAtEpoch');
    expect(foundation).toContain('Type: AWS::SecretsManager::Secret');
    expect(foundation.match(/DeletionPolicy: Retain/gu)).toHaveLength(2);
    expect(foundation).toContain('dynamodb:PutItem');
    expect(foundation).toContain('dynamodb:UpdateItem');
    expect(foundation).not.toContain('dynamodb:TransactWriteItems');
    expect(foundation).not.toContain('dynamodb:Scan');
    expect(foundation).toContain('log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*');
    expect(foundation).not.toContain('logs:PutResourcePolicy');
    expect(foundation).toContain('secretsmanager:GetSecretValue');
    expect(foundation).not.toContain('bedrock:InvokeModel');
    const stageValues = /AllowedValues:\n((?:\s+- [a-z]+\n)+)/u.exec(foundation)?.[1];
    expect(stageValues?.match(/- ([a-z]+)/gu)?.map((entry) => entry.slice(2))).toEqual([
      'dev',
      'test',
      'staging',
      'nonproduction',
      'production',
    ]);
    expect(stageValues).not.toMatch(/\b(?:prod|prd)\b/u);
  });

  it('uses an AgentCore-supported target account and region shape', () => {
    expect(deployment.awsTarget.account).toMatch(/^\d{12}$/u);
    expect(deployment.awsTarget.region).toBe('us-east-1');
  });
});
