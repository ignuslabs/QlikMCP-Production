import { describe, expect, it } from 'vitest';
import { resolveCatalogLabel } from '../../../src/catalog/resolver.js';
import { FixtureRepository } from '../../../src/adapters/fixture/fixtureRepository.js';

const repo = new FixtureRepository();
const catalog = repo.getCatalog('cloud-dev', 'app-sales-cloud-dev', 'default');

describe('resolveCatalogLabel', () => {
  it('resolves a master item in preference to a like-named field', () => {
    const ref = resolveCatalogLabel(catalog, 'Region');
    expect(ref).toMatchObject({
      catalogId: 'master-region',
      masterItemId: 'master-region',
      role: 'dimension',
    });
  });

  it('resolves a plain field label with no master item', () => {
    const ref = resolveCatalogLabel(catalog, 'CustomerID');
    expect(ref).toMatchObject({ catalogId: 'field-customer-id', role: 'dimension' });
    expect(ref.masterItemId).toBeUndefined();
  });

  it('rejects an unqualified ambiguous label with both candidate IDs', () => {
    expect.assertions(2);
    try {
      resolveCatalogLabel(catalog, 'Status');
    } catch (error) {
      const harnessError = error as { code: string; details?: { candidates?: string[] } };
      expect(harnessError.code).toBe('AMBIGUOUS_FIELD');
      expect(harnessError.details?.candidates).toEqual([
        'field-status-order',
        'field-status-customer',
      ]);
    }
  });

  it('resolves a qualified label unambiguously', () => {
    const ref = resolveCatalogLabel(catalog, 'Order.Status');
    expect(ref.catalogId).toBe('field-status-order');
  });

  it('rejects a sensitive field with the excluded metadata ID', () => {
    expect.assertions(2);
    try {
      resolveCatalogLabel(catalog, 'CustomerEmail');
    } catch (error) {
      const harnessError = error as { code: string; details?: { excludedMetadataId?: string } };
      expect(harnessError.code).toBe('SENSITIVE_FIELD');
      expect(harnessError.details?.excludedMetadataId).toBe('field-customer-email');
    }
  });

  it('rejects an unknown label', () => {
    expect.assertions(1);
    try {
      resolveCatalogLabel(catalog, 'NotInCatalog');
    } catch (error) {
      expect((error as { code: string }).code).toBe('UNKNOWN_FIELD');
    }
  });
});
