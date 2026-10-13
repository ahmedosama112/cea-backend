import express from 'express';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, auth, TestUser } from './helpers';
import { errorHandler } from '../src/middlewares/errorHandler';
import * as activity from '../src/services/activityLog';
import { errorDiagnostics } from '../src/utils/errorDiagnostics';

const fakeReq = (body: unknown = {}) =>
  ({ body, query: {}, get: () => undefined }) as unknown as Request;

describe('Request error security', () => {
  let admin: TestUser;
  const canary = 'request-security-sensitive-field-canary';

  beforeAll(async () => {
    await resetDb();
    admin = await createAdmin();
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(activity, 'logActivity').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('does not redact short non-secret values from env or request', () => {
    const prev = process.env.ACCESS_TOKEN_TTL_MIN;
    process.env.ACCESS_TOKEN_TTL_MIN = '15';
    try {
      const msg = 'Timed out after 15000ms reading undefined';
      const d = errorDiagnostics(new Error(msg), fakeReq({ token: 'e' }));
      expect(d.message).toBe(msg);
    } finally {
      if (prev === undefined) delete process.env.ACCESS_TOKEN_TTL_MIN;
      else process.env.ACCESS_TOKEN_TTL_MIN = prev;
    }
  });

  it('redacts both encoded and decoded database passwords', () => {
    const prev = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = 'mysql://u:p%40ss%2Fw0rd-canary@127.0.0.1:3306/cea_test';
    try {
      const d = errorDiagnostics(
        new Error('failed for p%40ss%2Fw0rd-canary and p@ss/w0rd-canary'), fakeReq());
      expect(d.message).not.toContain('w0rd-canary');
    } finally {
      if (prev === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = prev;
    }
  });

  function expectNoSensitiveLogging(body: unknown) {
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(canary);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(canary);
    const details = vi.mocked(activity.logActivity).mock.calls.map(([, event, opts]) => ({ event, opts }));
    expect(JSON.stringify(details)).not.toContain(canary);
    expect(JSON.stringify(body)).not.toContain(canary);
  }

  it('returns 400 for malformed login JSON without logging its password field', async () => {
    const res = await request(app).post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"unused@test.com","password":"${canary}",`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(console.warn).toHaveBeenCalledWith('Request body rejected:', { type: 'entity.parse.failed', status: 400 });
    expectNoSensitiveLogging(res.body);
  });

  it('returns 413 for oversized JSON without logging request contents', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'unused@test.com', password: canary + 'x'.repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(console.warn).toHaveBeenCalledWith('Request body rejected:', { type: 'entity.too.large', status: 413 });
    expectNoSensitiveLogging(res.body);
  });

  it.each(['/api/records/not-a-number', '/api/files/not-a-number/content', '/api/admin/users/not-a-number/settings'])
    ('rejects invalid identifiers at %s with 400', async (url) => {
      const res = await request(app).get(url).set(auth(admin.token));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(console.error).not.toHaveBeenCalled();
    });

  it('keeps unrelated SyntaxError failures as 500 without exposing their message or body', async () => {
    const failureApp = express();
    failureApp.get('/failure', (_req, _res, next) => {
      next(Object.assign(new SyntaxError(canary), { body: { password: canary } }));
    });
    failureApp.use(errorHandler);
    const res = await request(failureApp).get('/failure');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(console.error).toHaveBeenCalledWith('Unhandled error:', expect.objectContaining({
      name: 'SyntaxError', message: '[REDACTED]', stack: expect.stringContaining('at '),
    }));
    expect(activity.logActivity).toHaveBeenCalledWith(expect.anything(), 'API_ERR', { status: 500, detail: 'خطأ غير متوقع' });
    expectNoSensitiveLogging(res.body);
  });

  it('preserves useful server failure messages and stack frames in logs only', async () => {
    const failureApp = express();
    failureApp.get('/failure', (_req, _res, next) => next(new Error('Cannot reach database server')));
    failureApp.use(errorHandler);
    const res = await request(failureApp).get('/failure');
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith('Unhandled error:', expect.objectContaining({
      message: 'Cannot reach database server', stack: expect.stringContaining('at '),
    }));
    expect(JSON.stringify(res.body)).not.toContain('Cannot reach database server');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('redacts configured secrets, database credentials and request tokens from error diagnostics', async () => {
    const failureApp = express();
    const previousUrl = process.env.TEST_DATABASE_URL;
    const dbPassword = 'database-credential-canary';
    process.env.TEST_DATABASE_URL = `mysql://local:${dbPassword}@127.0.0.1:3306/cea_test`;
    try {
      failureApp.use(express.json());
      failureApp.post('/failure', (req, _res, next) => {
        next(new Error(`Database unavailable: ${dbPassword}; request token: ${req.body.refreshToken}`));
      });
      failureApp.use(errorHandler);
      const res = await request(failureApp).post('/failure').send({ refreshToken: canary });
      expect(res.status).toBe(500);
      const diagnostics = vi.mocked(console.error).mock.calls[0][1] as { message: string; stack: string };
      expect(diagnostics.message).toContain('Database unavailable');
      expect(diagnostics.stack).toContain('at ');
      expect(JSON.stringify(diagnostics)).not.toContain(dbPassword);
      expectNoSensitiveLogging(res.body);
    } finally {
      if (previousUrl === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previousUrl;
    }
  });
});
