import { describe, expect, it } from 'vitest';
import {
  resolveVisualizationSchema,
  VISUALIZATION_REGISTRY,
} from '../../../src/compiler/chartTypeRegistry.js';
import { CHART_TYPE_IDS } from '../../../src/domain/types.js';

describe('visualization registry', () => {
  it('contains versioned Qlik and Nebula identities for all nine logical visuals', () => {
    expect(Object.keys(VISUALIZATION_REGISTRY)).toEqual(CHART_TYPE_IDS);
    for (const chartType of CHART_TYPE_IDS) {
      const definition = VISUALIZATION_REGISTRY[chartType];
      expect(definition.logicalChartType).toBe(chartType);
      expect(definition.catalogChartType).toBeTruthy();
      expect(definition.profiles['qlik-cloud-current'].nebulaVisualizationId).toMatch(/^sn-/);
      expect(definition.qlikDevSpecVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(definition.qlikDevSpecUrl).toMatch(
        /^https:\/\/qlik\.dev\/specs\/javascript\/sn-.*\.json$/,
      );
    }
  });

  it('does not conflate table catalog, in-app, and Nebula identities', () => {
    const definition = VISUALIZATION_REGISTRY.table;
    expect(definition.catalogChartType).toBe('table');
    expect(definition.profiles['qlik-cloud-current'].nebulaVisualizationId).toBe('sn-table');
    expect(definition.profiles['qlik-windows-pre-november-2025'].nebulaVisualizationId).toBeNull();
    expect(definition.profiles['qlik-cloud-current'].qlikInAppVisualizationId).toBe('sn-table');
    expect(definition.profiles['qlik-windows-pre-november-2025'].qlikInAppVisualizationId).toBe(
      'table',
    );
  });

  it('resolves each current Cloud chart to its pinned property specification version', () => {
    for (const chartType of CHART_TYPE_IDS) {
      expect(
        resolveVisualizationSchema({
          chartType,
          platform: 'cloud',
          profile: 'qlik-cloud-current',
        }).propertySchemaVersion,
      ).toBe(VISUALIZATION_REGISTRY[chartType].qlikDevSpecVersion);
    }
  });

  it('requires a host-validated semantic property version for modern Windows', () => {
    expect(() =>
      resolveVisualizationSchema({
        chartType: 'table',
        platform: 'windows',
        profile: 'qlik-windows-november-2025-or-later',
      }),
    ).toThrow(/host-validated semantic sn-table property version/);
    expect(
      resolveVisualizationSchema({
        chartType: 'table',
        platform: 'windows',
        profile: 'qlik-windows-november-2025-or-later',
        hostValidatedVersion: '6.44.0',
      }),
    ).toMatchObject({
      qlikInAppVisualizationId: 'sn-table',
      propertySchemaBehavior: 'sn-table',
      propertySchemaVersion: '6.44.0',
    });
  });
});
