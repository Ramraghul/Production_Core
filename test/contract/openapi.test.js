'use strict';

/**
 * Contract tests.
 *
 * The valuable one here is drift detection: every route the Express router
 * actually serves must appear in the OpenAPI document, and vice versa. A
 * Swagger page that has drifted from its implementation is worse than no
 * Swagger page at all, because people trust it.
 */

const { buildSpec } = require('../../src/api/openapi');
const { buildRoutes } = require('../../src/api/routes');
const { makeContext } = require('../helpers/factory');

const spec = buildSpec();

/** Express path params are `:id`; OpenAPI's are `{id}`. */
const toOpenApiPath = (expressPath) =>
  expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/$/, '') || '/';

/** Every route the router serves, as `METHOD /path`. */
function collectRoutes() {
  const ctx = makeContext();
  const router = buildRoutes(ctx);
  const routes = [];

  for (const layer of router.stack) {
    if (!layer.route) continue;
    const path = toOpenApiPath(layer.route.path);
    for (const method of Object.keys(layer.route.methods)) {
      if (method === '_all') continue;
      routes.push({ method: method.toUpperCase(), path });
    }
  }
  return routes;
}

describe('OpenAPI document structure', () => {
  it('declares a supported OpenAPI version', () => {
    expect(spec.openapi).toMatch(/^3\.0\.\d+$/);
  });

  it('has the metadata a generator needs', () => {
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(spec.info.description.length).toBeGreaterThan(200);
    expect(spec.servers.length).toBeGreaterThan(0);
  });

  it('gives every operation a tag, a summary and at least one response', () => {
    // Problems are collected rather than asserted one at a time, so a failure
    // names every offending operation instead of only the first.
    const problems = [];
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const where = `${method.toUpperCase()} ${path}`;
        if (!operation.tags?.length) problems.push(`${where}: no tags`);
        if (!operation.summary) problems.push(`${where}: no summary`);
        if (!Object.keys(operation.responses || {}).length) problems.push(`${where}: no responses`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('uses only declared tags', () => {
    const declared = new Set(spec.tags.map((t) => t.name));
    const undeclared = new Set();
    for (const operations of Object.values(spec.paths)) {
      for (const operation of Object.values(operations)) {
        for (const tag of operation.tags || []) {
          if (!declared.has(tag)) undeclared.add(tag);
        }
      }
    }
    expect([...undeclared]).toEqual([]);
  });

  it('resolves every $ref', () => {
    const schemas = new Set(Object.keys(spec.components.schemas));
    const missing = [];

    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.$ref === 'string') {
        const name = node.$ref.replace('#/components/schemas/', '');
        if (!schemas.has(name)) missing.push(node.$ref);
      }
      Object.values(node).forEach(walk);
    };
    walk(spec.paths);
    walk(spec.components.schemas);

    expect(missing).toEqual([]);
  });

  it('declares a path parameter for every {placeholder} in a path', () => {
    const missing = [];
    for (const [path, operations] of Object.entries(spec.paths)) {
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      if (!placeholders.length) continue;

      for (const [method, operation] of Object.entries(operations)) {
        const declared = (operation.parameters || [])
          .filter((p) => p.in === 'path')
          .map((p) => p.name);
        placeholders
          .filter((placeholder) => !declared.includes(placeholder))
          .forEach((placeholder) => {
            missing.push(`${method.toUpperCase()} ${path}: no parameter for '${placeholder}'`);
          });
      }
    }
    expect(missing).toEqual([]);
  });

  it('marks every state-changing operation as requiring the API key', () => {
    const unsecured = [];
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!['post', 'put', 'patch', 'delete'].includes(method)) continue;
        if (!operation.security) unsecured.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(unsecured).toEqual([]);
  });
});

describe('spec and implementation agree', () => {
  const routes = collectRoutes();

  it('documents every route the API actually serves', () => {
    const undocumented = routes.filter(({ method, path }) => {
      const documented = spec.paths[path];
      return !documented || !documented[method.toLowerCase()];
    });

    expect(
      undocumented.map((r) => `${r.method} ${r.path}`)
    ).toEqual([]);
  });

  it('does not document routes that do not exist', () => {
    const served = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const phantom = [];

    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const method of Object.keys(operations)) {
        const key = `${method.toUpperCase()} ${path}`;
        if (!served.has(key)) phantom.push(key);
      }
    }

    expect(phantom).toEqual([]);
  });

  it('covers a meaningful surface', () => {
    expect(routes.length).toBeGreaterThan(50);
  });
});

describe('enums are generated from the live plant model', () => {
  const plantModel = require('../../src/core/plantModel');

  it('lists every real station in the station enum', () => {
    const stationEnum = spec.components.schemas.Station.properties.id.enum;
    expect(stationEnum).toHaveLength(plantModel.ALL_STATIONS.length);
    expect(stationEnum).toContain('CHAS-10');
  });

  it('lists every real model code', () => {
    expect(spec.components.schemas.WorkOrder.properties.modelCode.enum)
      .toEqual(plantModel.MODELS.map((m) => m.code));
  });

  it('lists every defect code from the catalogue', () => {
    const quality = require('../../src/core/quality');
    expect(spec.components.schemas.Defect.properties.code.enum)
      .toEqual(quality.DEFECT_CODES.map((d) => d.code));
  });
});
