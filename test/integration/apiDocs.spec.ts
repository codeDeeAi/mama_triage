import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/http/app';
import { TaskQueue } from '../../src/http/queue';
import { openApiSpec } from '../../src/http/openapi';

const silentLogger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
} as never;

/** Every optional surface switched on, so every route is mounted. */
function app(): Express {
  return createApp({
    appSecret: 'secret',
    verifyToken: 'verify',
    events: { async claim() { return true; }, async markProcessed() {}, async markFailed() {} } as never,
    audit: { async record() {} } as never,
    db: { healthy: async () => true } as never,
    queue: new TaskQueue(),
    logger: silentLogger,
    handleMessage: async () => undefined,
    admin: { isProduction: false } as never,
    demo: { enabled: true } as never,
    telegram: { secretToken: 't' } as never,
    register: { availableChannels: ['telegram'] } as never,
  });
}

/** Method + path pairs registered on the app, read from Express's router stack. */
function mountedRoutes(express: Express): string[] {
  const found: string[] = [];
  const walk = (stack: Array<Record<string, any>>): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          found.push(`${method} ${layer.route.path}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((express as any)._router.stack);
  return found;
}

describe('/api-docs', () => {
  it('serves Swagger UI', async () => {
    const res = await request(app()).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('serves the OpenAPI document as JSON', async () => {
    const res = await request(app()).get('/api-docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
  });

  it('documents every mounted route', () => {
    const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
    const undocumented = mountedRoutes(app())
      .filter((r) => !r.endsWith(' /api-docs.json'))
      .filter((r) => {
        const [method = '', path = ''] = r.split(' ');
        return !paths[path]?.[method];
      });
    expect(undocumented).toEqual([]);
  });

  it('gives every request body and every response a schema', () => {
    const missing: string[] = [];
    const paths = openApiSpec.paths as Record<string, Record<string, any>>;
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        // Every POST except session creation (which takes no body) must document one.
        if (method === 'post' && path !== '/demo/api/session') {
          const content = op.requestBody?.content ?? {};
          if (!Object.values(content).some((c: any) => c.schema)) {
            missing.push(`${method} ${path} request`);
          }
        }
        for (const [status, response] of Object.entries(op.responses as Record<string, any>)) {
          const content = response.content ?? {};
          if (!Object.values(content).some((c: any) => c.schema)) {
            missing.push(`${method} ${path} ${status}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('resolves every $ref', () => {
    const schemas = openApiSpec.components.schemas as Record<string, unknown>;
    const refs = JSON.stringify(openApiSpec).match(/#\/components\/schemas\/[A-Za-z]+/g) ?? [];
    const dangling = [...new Set(refs)].filter((r) => !(r.split('/').pop()! in schemas));
    expect(dangling).toEqual([]);
  });
});
