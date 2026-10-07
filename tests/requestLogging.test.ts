import express from 'express';
import morgan from 'morgan';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

describe('Production request log field escaping', () => {
  it.each([
    ['quotes', 'security-agent" fabricated-status="200'],
    ['Unicode separators', 'security-agent\u2028fabricated-entry\u2029tail'],
  ])('escapes %s in attacker-controlled headers', async (_name, userAgent) => {
    const entries: string[] = [];
    const app = express();
    app.use(morgan('combined', { stream: { write: (line: string) => { entries.push(line); } } }));
    // Inject the header inside the test: Node rejects Unicode separators in real HTTP headers.
    app.use((req, _res, next) => { req.headers['user-agent'] = userAgent; next(); });
    app.get('/logging-check', (_req, res) => { res.status(418).end('logging test'); });
    const res = await request(app).get('/logging-check');
    expect(res.status).toBe(418);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('"GET /logging-check HTTP/1.1" 418');
    expect(entries[0]).toContain(JSON.stringify(userAgent).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
    expect(entries[0].trimEnd()).not.toContain('\u2028');
    expect(entries[0].trimEnd()).not.toContain('\u2029');
  });
});
