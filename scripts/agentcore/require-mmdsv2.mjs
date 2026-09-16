#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  UpdateAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function optional(name, value) {
  return value === undefined ? {} : { [name]: value };
}

function assertRuntimeDidNotFail(runtimeId, runtime) {
  if (runtime.status === 'CREATE_FAILED' || runtime.status === 'UPDATE_FAILED') {
    throw new Error(
      `AgentCore Runtime ${runtimeId} is ${runtime.status}: ${runtime.failureReason ?? 'unknown'}`,
    );
  }
}

function isReadyWithMmdsV2(runtime) {
  return runtime.status === 'READY' && runtime.metadataConfiguration?.requireMMDSV2 === true;
}

async function waitForReady(client, runtimeId, current, deadline, pollIntervalMs) {
  let observed = current;
  for (;;) {
    assertRuntimeDidNotFail(runtimeId, observed);
    if (observed.status === 'READY') return observed;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for AgentCore Runtime ${runtimeId} to become READY (last status: ${observed.status ?? 'unknown'}).`,
      );
    }
    await delay(pollIntervalMs);
    observed = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
  }
}

async function waitForReadyMmdsV2(client, runtimeId, current, deadline, pollIntervalMs) {
  let observed = current;
  for (;;) {
    assertRuntimeDidNotFail(runtimeId, observed);
    if (isReadyWithMmdsV2(observed)) return observed;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for AgentCore Runtime ${runtimeId} to become READY with MMDSv2 (last status: ${observed.status ?? 'unknown'}).`,
      );
    }
    await delay(pollIntervalMs);
    observed = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
  }
}

export async function requireMmdsV2(client, runtimeId, options = {}) {
  let current = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
  assertRuntimeDidNotFail(runtimeId, current);
  if (isReadyWithMmdsV2(current)) {
    return { changed: false, runtimeId, status: current.status };
  }
  if (options.checkOnly) {
    if (current.metadataConfiguration?.requireMMDSV2 === true) {
      throw new Error(
        `AgentCore Runtime ${runtimeId} requires MMDSv2 but is not READY (status: ${current.status ?? 'unknown'}).`,
      );
    }
    throw new Error(`AgentCore Runtime ${runtimeId} does not require MMDSv2.`);
  }

  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60 * 1000);
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  if (current.status !== 'READY') {
    current = await waitForReady(client, runtimeId, current, deadline, pollIntervalMs);
  }
  if (current.metadataConfiguration?.requireMMDSV2 === true) {
    return { changed: false, runtimeId, status: current.status };
  }
  if (!current.agentRuntimeArtifact || !current.roleArn) {
    throw new Error(
      'AgentCore Runtime is missing the artifact or execution role required to update it.',
    );
  }
  current = await client.send(
    new UpdateAgentRuntimeCommand({
      agentRuntimeId: runtimeId,
      agentRuntimeArtifact: current.agentRuntimeArtifact,
      roleArn: current.roleArn,
      metadataConfiguration: { requireMMDSV2: true },
      clientToken: randomUUID(),
      ...optional('networkConfiguration', current.networkConfiguration),
      ...optional('description', current.description),
      ...optional('authorizerConfiguration', current.authorizerConfiguration),
      ...optional('requestHeaderConfiguration', current.requestHeaderConfiguration),
      ...optional('protocolConfiguration', current.protocolConfiguration),
      ...optional('lifecycleConfiguration', current.lifecycleConfiguration),
      ...optional('environmentVariables', current.environmentVariables),
      ...optional('filesystemConfigurations', current.filesystemConfigurations),
      ...optional('capacityProviderConfiguration', current.capacityProviderConfiguration),
    }),
  );
  current = await waitForReadyMmdsV2(client, runtimeId, current, deadline, pollIntervalMs);
  return { changed: true, runtimeId, status: current.status };
}

async function main() {
  const runtimeId = required(
    argument('--runtime-id') ?? process.env.QLIK_AGENTCORE_RUNTIME_ID,
    '--runtime-id or QLIK_AGENTCORE_RUNTIME_ID',
  );
  const region = required(
    argument('--region') ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    '--region, AWS_REGION, or AWS_DEFAULT_REGION',
  );
  const result = await requireMmdsV2(new BedrockAgentCoreControlClient({ region }), runtimeId, {
    checkOnly: process.argv.includes('--check-only'),
  });
  process.stderr.write(
    `[agentcore] MMDSv2 ${result.changed ? 'enabled' : 'already enabled'} for ${runtimeId} (${result.status ?? 'status unavailable'}).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[agentcore] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
