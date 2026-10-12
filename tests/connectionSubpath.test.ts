import { describe, expect, test } from 'bun:test';
import {
  computeApiUrl,
  detectApiBaseFromLocation,
  normalizeApiBase,
  resolvePanelBasePath,
} from '../src/utils/connection';

describe('reverse-proxy panel path detection', () => {
  test('preserves extensionless mount paths with and without a trailing slash', () => {
    expect(resolvePanelBasePath('/proxy')).toBe('/proxy');
    expect(resolvePanelBasePath('/proxy/')).toBe('/proxy');
    expect(resolvePanelBasePath('/tenants/acme')).toBe('/tenants/acme');
  });

  test('strips dashboard document names without misclassifying their directory', () => {
    expect(resolvePanelBasePath('/proxy/management.html')).toBe('/proxy');
    expect(resolvePanelBasePath('/proxy/index.htm')).toBe('/proxy');
    expect(resolvePanelBasePath('/management.html')).toBe('');
  });

  test('preserves dotted mount paths instead of treating every dot as a file extension', () => {
    expect(resolvePanelBasePath('/tenant.v1/')).toBe('/tenant.v1');
    expect(resolvePanelBasePath('/tenant.v1')).toBe('/tenant.v1');
    expect(resolvePanelBasePath('/tenant.json')).toBe('/tenant.json');
    expect(resolvePanelBasePath('/assets/tenant.json')).toBe('/assets/tenant.json');
    expect(resolvePanelBasePath('/proxy/static/tenant.js')).toBe('/proxy/static/tenant.js');
    expect(resolvePanelBasePath('/tenant.v1/management.html')).toBe('/tenant.v1');
    expect(resolvePanelBasePath('/tenant.v1/index.html')).toBe('/tenant.v1');
    expect(resolvePanelBasePath('/proxy/dashboard.js')).toBe('/proxy/dashboard.js');
    expect(resolvePanelBasePath('/groups/acme.prod/')).toBe('/groups/acme.prod');
  });

  test('keeps normalized management paths stable', () => {
    expect(normalizeApiBase('https://example.test/proxy/v8/management/')).toBe(
      'https://example.test/proxy'
    );
  });

  test('page detection preserves dotted mounts for requests and remembered panel identity', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
      for (const pathname of ['/tenant.v1', '/tenant.v1/', '/tenant.v1/management.html']) {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: {
            location: { protocol: 'https:', hostname: 'example.test', port: '8443', pathname },
          },
        });
        const base = detectApiBaseFromLocation();
        expect(base).toBe('https://example.test:8443/tenant.v1');
        expect(computeApiUrl(base)).toBe('https://example.test:8443/tenant.v1/v8/management');
      }
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
