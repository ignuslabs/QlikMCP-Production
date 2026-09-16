import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createError } from '../../domain/errors.js';
import { resolveFixturesDir } from '../../config/paths.js';
import type {
  CatalogDefinition,
  CatalogFixtureFile,
  CatalogTargetDefinition,
  CatalogVariant,
} from '../../catalog/catalogTypes.js';

/**
 * Read-only loader for the shared deterministic fixture contract in
 * `test/fixtures/catalog.json`. This is the canonical, hand-authored
 * logical catalog shared by the fixture-safe adapter and the test suite
 * (see docs/runbooks/fixture-artifacts.md); the harness never writes to
 * this file or to any other file under `test/fixtures`.
 */
export class FixtureRepository {
  private readonly catalogFile: CatalogFixtureFile;

  constructor(fixturesDir: string = resolveFixturesDir()) {
    const raw = readFileSync(path.join(fixturesDir, 'catalog.json'), 'utf8');
    this.catalogFile = JSON.parse(raw) as CatalogFixtureFile;
  }

  getTarget(connectionAlias: string): CatalogTargetDefinition {
    const target = this.catalogFile.targets.find(
      (entry) => entry.connectionAlias === connectionAlias,
    );
    if (!target) {
      throw createError('NOT_FOUND', {
        message: `Connection alias "${connectionAlias}" is not a known development target.`,
        details: { connectionAlias },
      });
    }
    return target;
  }

  assertApp(connectionAlias: string, appId: string): CatalogTargetDefinition {
    const target = this.getTarget(connectionAlias);
    if (target.app.id !== appId) {
      throw createError('NOT_FOUND', {
        message: `App "${appId}" was not found for connection "${connectionAlias}".`,
        details: { connectionAlias, appId },
      });
    }
    return target;
  }

  assertSheet(connectionAlias: string, appId: string, sheetId: string) {
    const target = this.assertApp(connectionAlias, appId);
    const sheet = target.sheets.find((entry) => entry.id === sheetId);
    if (!sheet) {
      throw createError('NOT_FOUND', {
        message: `Sheet "${sheetId}" was not found for app "${appId}".`,
        details: { connectionAlias, appId, sheetId },
      });
    }
    return sheet;
  }

  /** Returns the single write-allowed sheet for an app, when exactly one exists. */
  defaultWritableSheetId(connectionAlias: string, appId: string): string | undefined {
    const target = this.assertApp(connectionAlias, appId);
    const writable = target.sheets.filter((sheet) => sheet.writeAllowed);
    return writable.length === 1 ? writable[0]!.id : undefined;
  }

  getCatalog(
    connectionAlias: string,
    appId: string,
    variant: CatalogVariant = 'default',
  ): CatalogDefinition {
    const target = this.assertApp(connectionAlias, appId);
    const catalogRef = target.catalogVariants[variant];
    if (!catalogRef) {
      throw createError('NOT_FOUND', {
        message: `Catalog variant "${variant}" is not defined for connection "${connectionAlias}".`,
        details: { connectionAlias, variant },
      });
    }
    const catalog = this.catalogFile.catalogs[catalogRef];
    if (!catalog) {
      throw createError('NOT_FOUND', {
        message: `Catalog "${catalogRef}" was not found.`,
        details: { catalogRef },
      });
    }
    return catalog;
  }
}

/** Throws EMPTY_CATALOG when the catalog has no policy-visible fields or master items. */
export function assertCatalogNotEmpty(catalog: CatalogDefinition): void {
  if (catalog.fields.length === 0 && catalog.masterItems.length === 0) {
    throw createError('EMPTY_CATALOG');
  }
}
