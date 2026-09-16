import { z } from 'zod';
import {
  OAuthHostConfigFactory,
  type CloudOAuthClientSecretProvider,
} from '../adapters/cloud/cloudOAuth.js';
import type { TargetAdapter } from '../adapters/targetAdapter.js';
import { createError } from '../domain/errors.js';
import { ArtifactService } from './artifacts.js';
import { CloudRestManagementProvider } from './cloudRestProvider.js';
import {
  CloudEngineManagementProvider,
  ENGINE_ACTION_SCHEMAS,
  ENGINE_MUTATION_ACTIONS,
} from './cloudEngineProvider.js';
import { REST_ACTION_SCHEMAS, REST_READ_ACTIONS } from './restContracts.js';
import { validateDatasetUpload, compileDataManifest, profileDataRows } from './dataPreparation.js';
import {
  dataManifestSchema,
  dataQualityRequestSchema,
  type ApprovedDataFile,
} from './dataContracts.js';
import {
  loadManagementPolicy,
  ManagementPolicyEngine,
  type ManagementActor,
  type ManagementTarget,
} from './policy.js';
import { ManagementWorkflow, type ActionRegistry, type ActionDefinition } from './workflow.js';
import type { ManagementStore } from './state.js';

export interface ManagementContext {
  readonly workflow: ManagementWorkflow;
  readonly artifacts: ArtifactService;
  readonly policy: ManagementPolicyEngine;
  readonly authorizeArtifact?: (
    artifactId: string,
    connection: string,
    action: string,
  ) => Promise<void>;
}

function targetOf(value: Record<string, unknown>): ManagementTarget {
  return {
    ...(typeof value.appId === 'string' ? { appId: value.appId } : {}),
    ...(typeof value.spaceId === 'string' ? { spaceId: value.spaceId } : {}),
    ...(typeof value.targetSpaceId === 'string' ? { targetSpaceId: value.targetSpaceId } : {}),
    ...(value.spaceId === null ? { personalSpace: true } : {}),
    ...(value.targetSpaceId === null ? { targetPersonalSpace: true } : {}),
  };
}

const stagedId = z.string().regex(/^artifact-[0-9a-f-]{36}$/);
const uploadSchema = z
  .object({
    connection: z.string().min(1),
    artifactId: stagedId,
    spaceId: z.string().min(1).nullable(),
    appId: z.string().min(1).optional(),
    folderId: z.string().min(1).optional(),
  })
  .strict();
const replaceSchema = z
  .object({
    connection: z.string().min(1),
    artifactId: stagedId,
    fileId: z.string().min(1),
    expectedSourceVersion: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export function buildManagementContext(options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly actor: ManagementActor;
  readonly store: ManagementStore;
  readonly cloudClientSecrets?: CloudOAuthClientSecretProvider;
  readonly cloudAdapter?: TargetAdapter;
}): ManagementContext | undefined {
  const policy = new ManagementPolicyEngine(loadManagementPolicy(options.environment));
  if (!policy.policy.enabled) return undefined;
  if (options.environment.QLIK_HARNESS_TARGET_MODE !== 'cloud' || !options.cloudClientSecrets)
    throw createError('NOT_CONFIGURED', {
      message:
        'Management features require configured Qlik Cloud credentials and an explicit policy.',
    });
  const factory = new OAuthHostConfigFactory({
    connection: options.environment.QLIK_CLOUD_CONNECTION_ALIAS ?? '',
    tenantHost: options.environment.QLIK_CLOUD_TENANT_HOST ?? '',
    clientId: options.environment.QLIK_CLOUD_OAUTH_CLIENT_ID ?? '',
    clientSecrets: options.cloudClientSecrets,
  });
  const artifacts = new ArtifactService(options.store, policy.policy.maxArtifactBytes);
  const rest: CloudRestManagementProvider = new CloudRestManagementProvider({
    getHostConfig: (connection) => factory.getHostConfig(connection),
    maxUploadBytes: policy.policy.maxUploadBytes,
    maxArtifactBytes: policy.policy.maxArtifactBytes,
    storeArtifact: async (blob, metadata) => {
      if (blob.size > policy.policy.maxArtifactBytes) throw createError('CAPACITY_EXHAUSTED');
      const app = await rest.inspect('app.get', {
        connection: metadata.connection,
        appId: metadata.appId,
      });
      return artifacts.save(options.actor.actor, Buffer.from(await blob.arrayBuffer()), {
        connection: metadata.connection,
        appId: metadata.appId,
        ...(typeof app.spaceId === 'string' ? { spaceId: app.spaceId } : {}),
        filename: metadata.filename,
        mimeType: blob.type || 'application/octet-stream',
        purpose: metadata.kind,
      });
    },
  });
  const engine = new CloudEngineManagementProvider(
    (connection) => factory.getHostConfig(connection),
    undefined,
    {
      getCatalog: async (connection, appId) => {
        if (!options.cloudAdapter) throw createError('NOT_CONFIGURED');
        return (await options.cloudAdapter.getCompilationContext(connection, appId, options.actor))
          .catalog;
      },
    },
  );
  const actions: Record<string, ActionDefinition> = {};
  const inspectRest = async (
    action: string,
    input: Record<string, unknown>,
  ): Promise<ManagementTarget> => {
    const inspected = await rest.inspect(action, input);
    if (inspected.exists !== true)
      throw createError('MALFORMED_REQUEST', {
        message: 'The management target was not found; no scope could be authorized.',
        details: { outcome: 'absent' },
      });
    // App-backed resources inherit the live parent's scope, including files whose API space is null.
    if (typeof inspected.appId === 'string' && !action.startsWith('app.')) {
      const app = await rest.inspect('app.get', {
        connection: input.connection,
        appId: inspected.appId,
      });
      if (app.exists !== true)
        throw createError('MALFORMED_REQUEST', {
          message: 'The parent app was not found; no scope could be authorized.',
          details: { outcome: 'absent' },
        });
      return targetOf({ ...inspected, spaceId: app.spaceId });
    }
    return targetOf(inspected);
  };
  for (const [action, schema] of Object.entries(REST_ACTION_SCHEMAS)) {
    if (action === 'datafile.upload' || action === 'datafile.replace') continue;
    actions[action] = {
      schema,
      readOnly: REST_READ_ACTIONS.has(action),
      inspect: (input) => inspectRest(action, input),
      execute: async (input, onReceipt) => {
        const result = await rest.execute(action, input, onReceipt);
        if (action === 'space.list' && Array.isArray(result.items)) {
          const grant = policy.grant(options.actor, String(input.connection), action);
          const items = result.items.filter(
            (item) =>
              !!item &&
              typeof item === 'object' &&
              grant.spaceIds.includes(String((item as Record<string, unknown>).spaceId)),
          );
          return { ...result, items, count: items.length };
        }
        if (action === 'app.list' && Array.isArray(result.items)) {
          const grant = policy.grant(options.actor, String(input.connection), action);
          const items = result.items.filter((item) => {
            if (!item || typeof item !== 'object') return false;
            const app = item as Record<string, unknown>;
            return (
              (typeof app.appId === 'string' && grant.appIds.includes(app.appId)) ||
              (typeof app.spaceId === 'string' && grant.spaceIds.includes(app.spaceId)) ||
              (app.spaceId === null && grant.allowPersonalSpace)
            );
          });
          return { ...result, items, count: items.length };
        }
        return result;
      },
      ...(!REST_READ_ACTIONS.has(action)
        ? {
            verify: async (input: Record<string, unknown>, result: Record<string, unknown>) => {
              if (action === 'app.export') {
                const exported =
                  typeof result.artifactId !== 'string' && typeof result.exportId === 'string'
                    ? await rest.resumeExport(
                        { connection: String(input.connection), appId: String(input.appId) },
                        { appId: String(result.appId), exportId: result.exportId },
                      )
                    : result;
                const artifact = await artifacts.read(
                  options.actor.actor,
                  String(exported.artifactId),
                );
                return {
                  verified:
                    artifact.metadata.sha256 === exported.sha256 &&
                    artifact.metadata.byteLength === exported.byteLength,
                  verificationScope: 'private-artifact-checksum',
                  result: exported,
                };
              }
              return rest.verify(action, input, result);
            },
          }
        : {}),
    };
  }
  for (const [action, schema] of Object.entries(ENGINE_ACTION_SCHEMAS))
    actions[action] = {
      schema,
      readOnly: !ENGINE_MUTATION_ACTIONS.has(action),
      inspect: (input) =>
        inspectRest('app.get', { connection: input.connection, appId: input.appId }),
      execute: (input) => engine.execute(action, input),
      ...(ENGINE_MUTATION_ACTIONS.has(action)
        ? {
            verify: async (input: Record<string, unknown>, result: Record<string, unknown>) => ({
              verified: await engine.verify(action, input, result),
            }),
          }
        : {}),
    };
  for (const action of ['datafile.upload', 'datafile.replace'] as const) {
    const resolveUpload = async (input: Record<string, unknown>) => {
      const artifact = await artifacts.read(options.actor.actor, String(input.artifactId));
      if (
        artifact.metadata.connection !== input.connection ||
        artifact.metadata.purpose !== 'dataset'
      )
        throw createError('PERMISSION_DENIED');
      await validateDatasetUpload({
        filename: artifact.metadata.filename,
        mimeType: artifact.metadata.mimeType,
        contentBase64: artifact.bytes.toString('base64'),
        expectedSha256: artifact.metadata.sha256,
        csvDelimiter: artifact.metadata.csvDelimiter,
      });
      const { artifactId: _artifactId, ...restInput } = input;
      const providerInput = {
        ...restInput,
        name: artifact.metadata.filename,
        contentBase64: artifact.bytes.toString('base64'),
        contentSha256: artifact.metadata.sha256,
      };
      return { artifact, providerInput };
    };
    actions[action] = {
      schema: action === 'datafile.upload' ? uploadSchema : replaceSchema,
      readOnly: false,
      inspect: async (input) => {
        const { artifact, providerInput } = await resolveUpload(input);
        const target = await inspectRest(action, providerInput);
        if (
          artifact.metadata.spaceId &&
          artifact.metadata.spaceId !== (target.targetSpaceId ?? target.spaceId)
        )
          throw createError('PERMISSION_DENIED');
        return target;
      },
      execute: async (input) => rest.execute(action, (await resolveUpload(input)).providerInput),
      verify: async (input, result) =>
        rest.verify(action, (await resolveUpload(input)).providerInput, result),
    };
  }
  actions['data.profile'] = {
    schema: dataQualityRequestSchema.safeExtend({ connection: z.string().min(1) }).strict(),
    readOnly: true,
    inspect: async () => ({}),
    execute: async (input) => {
      const { connection: _connection, ...request } = input;
      return { ...profileDataRows(request) };
    },
  };
  actions['data.prepare'] = {
    schema: z
      .object({
        connection: z.string().min(1),
        appId: z.string().min(1),
        manifest: dataManifestSchema,
      })
      .strict(),
    readOnly: true,
    inspect: (input) =>
      inspectRest('app.get', { connection: input.connection, appId: input.appId }),
    execute: async (input) => {
      const manifest = dataManifestSchema.parse(input.manifest);
      const app = await rest.execute('app.get', {
        connection: input.connection,
        appId: input.appId,
      });
      const space =
        typeof app.spaceId === 'string'
          ? await rest.execute('space.get', {
              connection: input.connection,
              spaceId: app.spaceId,
            })
          : undefined;
      if (space && (space.spaceId !== app.spaceId || typeof space.name !== 'string'))
        throw createError('NOT_CONFIGURED', {
          message: 'The dataset space name could not be verified for script generation.',
        });
      const approved: ApprovedDataFile[] = [];
      const fileVersions: Record<string, string> = {};
      for (const table of manifest.tables) {
        if (approved.some((file) => file.dataFileId === table.source.dataFileId)) continue;
        const file = await rest.execute('datafile.get', {
          connection: input.connection,
          fileId: table.source.dataFileId,
        });
        if (file.appId && file.appId !== input.appId) throw createError('PERMISSION_DENIED');
        const fileSpace = file.appId && file.spaceId == null ? app.spaceId : file.spaceId;
        policy.authorizeTarget(
          policy.grant(options.actor, String(input.connection), 'data.prepare'),
          targetOf({ ...file, spaceId: fileSpace }),
        );
        if (fileSpace !== app.spaceId) throw createError('PERMISSION_DENIED');
        if (file.folderId && !file.folderPath)
          throw createError('NOT_CONFIGURED', {
            message: 'The dataset folder path could not be verified for script generation.',
          });
        if (!String(file.name).toLowerCase().endsWith(`.${table.source.format}`))
          throw createError('MALFORMED_REQUEST', {
            message: 'The data source format does not match the provider file name.',
          });
        approved.push({
          dataFileId: table.source.dataFileId,
          filename: String(file.name),
          format: table.source.format,
          ...(space ? { spaceName: String(space.name) } : {}),
          ...(typeof file.folderPath === 'string' ? { folderPath: file.folderPath } : {}),
        });
        fileVersions[table.source.dataFileId] = String(file.sourceVersion);
      }
      return { ...compileDataManifest(manifest, approved), fileVersions };
    },
  };
  actions['script.apply'] = {
    schema: z
      .object({
        connection: z.string().min(1),
        appId: z.string().min(1),
        expectedHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        manifest: dataManifestSchema,
        fileVersions: z.union([
          z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
          z
            .array(
              z
                .object({
                  fileId: z.string().min(1),
                  sourceVersion: z.string().regex(/^[0-9a-f]{64}$/),
                })
                .strict(),
            )
            .min(1)
            .max(20),
        ]),
      })
      .strict(),
    readOnly: false,
    inspect: (input) =>
      inspectRest('app.get', { connection: input.connection, appId: input.appId }),
    execute: async (input) => {
      const manifest = dataManifestSchema.parse(input.manifest);
      const versions = Array.isArray(input.fileVersions)
        ? Object.fromEntries(
            input.fileVersions.map((item: { fileId: string; sourceVersion: string }) => [
              item.fileId,
              item.sourceVersion,
            ]),
          )
        : (input.fileVersions as Record<string, string>);
      for (const id of new Set(manifest.tables.map((table) => table.source.dataFileId))) {
        const file = await rest.execute('datafile.get', {
          connection: input.connection,
          fileId: id,
        });
        if (file.sourceVersion !== versions[id])
          throw createError('IDEMPOTENCY_CONFLICT', {
            message: 'A source dataset changed after the script was planned.',
            details: { outcome: 'rejected', dispatch: 'not-started' },
          });
      }
      const prepared = await actions['data.prepare']!.execute({
        connection: input.connection,
        appId: input.appId,
        manifest,
      });
      const currentVersions = prepared.fileVersions as Record<string, string>;
      if (Object.entries(currentVersions).some(([id, version]) => versions[id] !== version))
        throw createError('IDEMPOTENCY_CONFLICT', {
          message: 'A source dataset changed while the script was being prepared.',
          details: { outcome: 'rejected', dispatch: 'not-started' },
        });
      return engine.execute('script.set', {
        connection: input.connection,
        appId: input.appId,
        expectedHash: input.expectedHash,
        script: prepared.loadScript,
      });
    },
    verify: async (input, result) => {
      const prepared = await actions['data.prepare']!.execute({
        connection: input.connection,
        appId: input.appId,
        manifest: input.manifest,
      });
      return {
        verified: await engine.verify(
          'script.set',
          {
            connection: input.connection,
            appId: input.appId,
            expectedHash: input.expectedHash,
            script: prepared.loadScript,
          },
          result,
        ),
      };
    },
  };
  actions['reload.wait'] = {
    schema: z.object({ connection: z.string().min(1), reloadId: z.string().min(1) }).strict(),
    readOnly: true,
    inspect: (input) => inspectRest('reload.get', input),
    execute: async (input) => {
      const result = await rest.execute('reload.get', input);
      if (result.terminal && result.status !== 'SUCCEEDED')
        throw createError('MALFORMED_REQUEST', {
          message: 'The reload reached a terminal failure; inspect its private log.',
          details: {
            outcome: 'terminal-failure',
            reloadId: String(input.reloadId),
            status: String(result.status),
          },
        });
      return { ...result, workflowPending: result.status !== 'SUCCEEDED' };
    },
  };
  const authorizeArtifact = async (artifactId: string, connection: string, action: string) => {
    const record = await artifacts.inspect(options.actor.actor, artifactId);
    if (record.data.connection !== connection) throw createError('PERMISSION_DENIED');
    const target =
      typeof record.data.appId === 'string'
        ? await inspectRest('app.get', { connection, appId: record.data.appId })
        : typeof record.data.spaceId === 'string'
          ? { spaceId: record.data.spaceId }
          : { personalSpace: true };
    policy.authorizeTarget(policy.grant(options.actor, connection, action), target);
  };
  return {
    workflow: new ManagementWorkflow(
      options.actor,
      policy,
      options.store,
      actions as ActionRegistry,
    ),
    artifacts,
    policy,
    authorizeArtifact,
  };
}
