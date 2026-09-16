import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRepoRoot } from './paths.js';
import {
  CHART_TYPE_IDS,
  VISUALIZATION_SCHEMA_PROFILE_IDS,
  type ChartTypeId,
  type ConnectionAlias,
  type PlatformId,
  type VisualizationSchemaProfileId,
} from '../domain/types.js';
import {
  isValidVisualizationSchemaVersion,
  VISUALIZATION_SCHEMA_PROFILES,
} from '../compiler/chartTypeRegistry.js';

/**
 * Non-secret connection allowlist configuration. Loaded from
 * `QLIK_HARNESS_CONNECTIONS_JSON` when supplied by a deployment, otherwise
 * from `config/connections.json` (a local, gitignored override) when present,
 * or the committed `config/connections.example.json` template. The inline
 * value is non-secret policy data and is validated by the same fail-closed
 * parser as file-backed configuration.
 */

export interface SheetGenerationPolicy {
  readonly actors: readonly string[];
  readonly appIds: readonly string[];
  readonly chartTypes: readonly ChartTypeId[];
  readonly maxCharts: number;
  readonly allowProduction: boolean;
}

export interface ConnectionAllowlistEntry {
  readonly alias: ConnectionAlias;
  readonly platform: PlatformId;
  /** Required for loaded deployment policy; optional only for legacy in-memory callers. */
  readonly visualizationSchemaProfile?: VisualizationSchemaProfileId;
  readonly visualizationSchemaVersion?: string;
  readonly environment: string;
  readonly allowedApps: Readonly<Record<string, readonly string[]>>;
  readonly allowedChartTypes: readonly ChartTypeId[];
  readonly sheetGeneration?: SheetGenerationPolicy;
}

export interface PolicyConfig {
  readonly allowedEnvironments: readonly string[];
  readonly connections: Readonly<Record<string, ConnectionAllowlistEntry>>;
  readonly mutationActors: ReadonlySet<string>;
  readonly reviewerActors: ReadonlySet<string>;
}

interface ConnectionsFileEntry {
  readonly alias: string;
  readonly platform: string;
  readonly visualizationSchemaProfile: VisualizationSchemaProfileId;
  readonly visualizationSchemaVersion?: string;
  readonly environment: string;
  readonly productionUse?: boolean;
  readonly sheetGeneration?: SheetGenerationPolicy;
  readonly allowedApps?: Readonly<Record<string, readonly string[]>>;
  readonly allowedChartTypes?: readonly ChartTypeId[];
}

interface ConnectionsFile {
  readonly allowedEnvironments?: readonly string[];
  readonly connections: readonly ConnectionsFileEntry[];
}

const CHART_TYPE_ID_SET: ReadonlySet<string> = new Set(CHART_TYPE_IDS);
const VISUALIZATION_SCHEMA_PROFILE_ID_SET: ReadonlySet<string> = new Set(
  VISUALIZATION_SCHEMA_PROFILE_IDS,
);
const DEPLOYMENT_ENVIRONMENT_CLASSES = ['development', 'nonproduction'] as const;
const DEPLOYMENT_ENVIRONMENT_CLASS_SET: ReadonlySet<string> = new Set(
  DEPLOYMENT_ENVIRONMENT_CLASSES,
);

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${name} must be an array of non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
}

function parseSheetGeneration(value: unknown): SheetGenerationPolicy | undefined {
  if (value === undefined) return undefined;
  const policy = recordOf(value);
  const keys = ['actors', 'appIds', 'chartTypes', 'maxCharts', 'allowProduction'];
  if (!policy || Object.keys(policy).some((key) => !keys.includes(key))) {
    throw new Error(
      'sheetGeneration must contain only actors, appIds, chartTypes, maxCharts and allowProduction.',
    );
  }
  const actors = stringArray(policy.actors, 'sheetGeneration actors');
  const appIds = stringArray(policy.appIds, 'sheetGeneration appIds');
  const chartTypes = stringArray(policy.chartTypes, 'sheetGeneration chartTypes');
  if (
    !actors.length ||
    !appIds.length ||
    !chartTypes.length ||
    chartTypes.some((type) => !CHART_TYPE_ID_SET.has(type)) ||
    !Number.isInteger(policy.maxCharts) ||
    (policy.maxCharts as number) < 1 ||
    (policy.maxCharts as number) > 12 ||
    typeof policy.allowProduction !== 'boolean'
  ) {
    throw new Error(
      'sheetGeneration requires explicit actors/apps/chart types, maxCharts 1-12, and boolean allowProduction.',
    );
  }
  return {
    actors,
    appIds,
    chartTypes: chartTypes as ChartTypeId[],
    maxCharts: policy.maxCharts as number,
    allowProduction: policy.allowProduction,
  };
}

function parseConnectionsFile(raw: string): ConnectionsFile {
  const root = recordOf(JSON.parse(raw));
  if (!root || !Array.isArray(root.connections)) {
    throw new Error('Connections configuration must contain a connections array.');
  }

  const connections = root.connections.map((value, index): ConnectionsFileEntry => {
    const entry = recordOf(value);
    if (!entry) throw new Error(`Connection ${index} must be an object.`);
    const alias = typeof entry?.alias === 'string' ? entry.alias.trim() : '';
    const platform = typeof entry?.platform === 'string' ? entry.platform.trim() : '';
    const visualizationSchemaProfile =
      typeof entry?.visualizationSchemaProfile === 'string'
        ? entry.visualizationSchemaProfile.trim()
        : '';
    const environment = typeof entry?.environment === 'string' ? entry.environment.trim() : '';
    if (!alias || !platform || !visualizationSchemaProfile || !environment) {
      throw new Error(
        `Connection ${index} requires alias, platform, visualizationSchemaProfile, and environment.`,
      );
    }
    if (!VISUALIZATION_SCHEMA_PROFILE_ID_SET.has(visualizationSchemaProfile)) {
      throw new Error(
        `Connection "${alias}" contains unknown visualization schema profile "${visualizationSchemaProfile}".`,
      );
    }
    const mappedPlatform = mapPlatform(platform);
    const typedVisualizationSchemaProfile =
      visualizationSchemaProfile as VisualizationSchemaProfileId;
    const schemaProfile = VISUALIZATION_SCHEMA_PROFILES[typedVisualizationSchemaProfile];
    if (schemaProfile.platform !== mappedPlatform) {
      throw new Error(
        `Connection "${alias}" visualization schema profile "${visualizationSchemaProfile}" does not match platform "${platform}".`,
      );
    }
    const visualizationSchemaVersion =
      typeof entry.visualizationSchemaVersion === 'string'
        ? entry.visualizationSchemaVersion.trim()
        : undefined;
    if (
      entry.visualizationSchemaVersion !== undefined &&
      (visualizationSchemaVersion === undefined || !visualizationSchemaVersion)
    ) {
      throw new Error(
        `Connection "${alias}" visualizationSchemaVersion must be a non-empty string.`,
      );
    }
    if (schemaProfile.snTablePropertyVersionSource === 'host-validated') {
      if (
        visualizationSchemaVersion === undefined ||
        !isValidVisualizationSchemaVersion(visualizationSchemaVersion)
      ) {
        throw new Error(
          `Connection "${alias}" requires a host-validated semantic visualizationSchemaVersion.`,
        );
      }
    } else if (visualizationSchemaVersion !== undefined) {
      throw new Error(
        `Connection "${alias}" must omit visualizationSchemaVersion for profile "${visualizationSchemaProfile}".`,
      );
    }
    if (entry.productionUse !== undefined && typeof entry.productionUse !== 'boolean') {
      throw new Error(`Connection "${alias}" productionUse must be a boolean.`);
    }
    const sheetGeneration = parseSheetGeneration(entry.sheetGeneration);
    if (
      (entry.productionUse || environment.toLowerCase() === 'production') &&
      !(environment === 'production' && sheetGeneration?.allowProduction === true)
    ) {
      throw new Error(`Refusing to load connection "${alias}": production use is prohibited.`);
    }

    const rawAllowedApps = entry.allowedApps === undefined ? {} : recordOf(entry.allowedApps);
    if (!rawAllowedApps) throw new Error(`Connection "${alias}" allowedApps must be an object.`);
    const allowedApps = Object.fromEntries(
      Object.entries(rawAllowedApps).map(([appId, sheetIds]) => {
        if (!appId.trim()) throw new Error(`Connection "${alias}" contains an empty app ID.`);
        return [appId, stringArray(sheetIds, `Connection "${alias}" sheet allowlist`)] as const;
      }),
    );

    const allowedChartTypes =
      entry.allowedChartTypes === undefined
        ? []
        : stringArray(entry.allowedChartTypes, `Connection "${alias}" chart allowlist`).map(
            (chartType) => {
              if (!CHART_TYPE_ID_SET.has(chartType)) {
                throw new Error(
                  `Connection "${alias}" contains unsupported chart type "${chartType}".`,
                );
              }
              return chartType as ChartTypeId;
            },
          );

    return {
      alias,
      platform,
      visualizationSchemaProfile: typedVisualizationSchemaProfile,
      ...(visualizationSchemaVersion ? { visualizationSchemaVersion } : {}),
      environment,
      ...(entry.productionUse === false ? { productionUse: false } : {}),
      allowedApps,
      allowedChartTypes,
      ...(sheetGeneration ? { sheetGeneration } : {}),
    };
  });

  const allowedEnvironments =
    root.allowedEnvironments === undefined
      ? undefined
      : stringArray(root.allowedEnvironments, 'allowedEnvironments');
  return { connections, ...(allowedEnvironments ? { allowedEnvironments } : {}) };
}

function assertInlineDeploymentPolicy(parsed: ConnectionsFile): void {
  const allowedEnvironments = parsed.allowedEnvironments ?? DEPLOYMENT_ENVIRONMENT_CLASSES;
  if (
    allowedEnvironments.some(
      (environment) =>
        !DEPLOYMENT_ENVIRONMENT_CLASS_SET.has(environment) && environment !== 'production',
    )
  ) {
    throw new Error(
      'Inline deployment allowedEnvironments must contain only development or nonproduction.',
    );
  }
  for (const connection of parsed.connections) {
    if (
      !DEPLOYMENT_ENVIRONMENT_CLASS_SET.has(connection.environment) &&
      !(connection.environment === 'production' && connection.sheetGeneration?.allowProduction)
    ) {
      throw new Error(
        `Inline deployment connection "${connection.alias}" must use environment development or nonproduction.`,
      );
    }
    if (!allowedEnvironments.includes(connection.environment)) {
      throw new Error(
        `Inline deployment connection "${connection.alias}" environment is not allowlisted.`,
      );
    }
  }
}

function mapPlatform(raw: string): PlatformId {
  if (raw === 'qlik-cloud') return 'cloud';
  if (raw === 'qlik-sense-enterprise-on-windows') return 'windows';
  throw new Error(`Unknown connection platform "${raw}" in connections configuration.`);
}

function parseActorSet(
  environmentName: string,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  const raw = environment[environmentName] ?? '';
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

export function loadPolicyConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PolicyConfig {
  const configDir = environment.QLIK_HARNESS_CONFIG_DIR ?? path.join(resolveRepoRoot(), 'config');
  const overridePath = path.join(configDir, 'connections.json');
  const templatePath = path.join(configDir, 'connections.example.json');
  const filePath = existsSync(overridePath) ? overridePath : templatePath;
  const inlineConfiguration = environment.QLIK_HARNESS_CONNECTIONS_JSON?.trim();
  const parsed = parseConnectionsFile(
    inlineConfiguration ? inlineConfiguration : readFileSync(filePath, 'utf8'),
  );
  if (inlineConfiguration) assertInlineDeploymentPolicy(parsed);

  const connections: Record<string, ConnectionAllowlistEntry> = {};
  for (const entry of parsed.connections) {
    if (connections[entry.alias]) {
      throw new Error(`Duplicate connection alias "${entry.alias}" in connections configuration.`);
    }
    connections[entry.alias] = {
      alias: entry.alias,
      platform: mapPlatform(entry.platform),
      visualizationSchemaProfile: entry.visualizationSchemaProfile,
      ...(entry.visualizationSchemaVersion
        ? { visualizationSchemaVersion: entry.visualizationSchemaVersion }
        : {}),
      environment: entry.environment,
      allowedApps: entry.allowedApps ?? {},
      allowedChartTypes: entry.allowedChartTypes ?? [],
      ...(entry.sheetGeneration ? { sheetGeneration: entry.sheetGeneration } : {}),
    };
  }

  return {
    allowedEnvironments: parsed.allowedEnvironments ?? DEPLOYMENT_ENVIRONMENT_CLASSES,
    connections,
    mutationActors: parseActorSet('QLIK_HARNESS_MUTATION_ACTORS', environment),
    reviewerActors: parseActorSet('QLIK_HARNESS_REVIEWER_ACTORS', environment),
  };
}
