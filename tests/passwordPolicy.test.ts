import bcrypt from 'bcryptjs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, auth, TestUser } from './helpers';
import { newPasswordSchema, passwordResetConfirmSchema } from '../src/schema/auth.schema';
import { hashPassword } from '../src/utils/password';

describe('New password byte limits and legacy compatibility', () => {
  let admin: TestUser;
  beforeAll(async () => { await resetDb(); admin = await createAdmin(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it.each([
    ['ASCII at limit', 'a'.repeat(72), true],
    ['ASCII over limit', 'a'.repeat(73), false],
    ['Arabic at limit', 'ع'.repeat(36), true],
    ['Arabic over limit', 'ع'.repeat(37), false],
    ['emoji at limit', '🔐'.repeat(18), true],
    ['emoji over limit', '🔐'.repeat(19), false],
  ])('checks UTF-8 bytes: %s', (_label, password, accepted) => {
    expect(newPasswordSchema.safeParse(password).success).toBe(accepted);
  });

  it('rejects overlong passwords even if hashing is called outside a route', () => {
    expect(() => hashPassword('ع'.repeat(37))).toThrow();
  });

  it('uses the same limit for the currently disabled user reset schema', () => {
    expect(passwordResetConfirmSchema.safeParse({ token: 'x'.repeat(30), newPassword: 'ع'.repeat(37) }).success).toBe(false);
  });

  it.each(['register', 'admin create', 'admin reset', 'change password'])('rejects overlong values in %s without changing the account', async (route) => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: BigInt(admin.id) } });
    const password = 'ع'.repeat(37);
    let res;
    if (route === 'register') res = await request(app).post('/api/auth/register').set(auth(admin.token)).send({ email: 'over-register@test.com', password });
    else if (route === 'admin create') res = await request(app).post('/api/admin/users').set(auth(admin.token)).send({ email: 'over-admin@test.com', password });
    else if (route === 'admin reset') res = await request(app).post(`/api/admin/users/${admin.id}/reset-password`).set(auth(admin.token)).send({ newPassword: password });
    else res = await request(app).post('/api/auth/change-password').set(auth(admin.token)).send({ currentPassword: 'password123', newPassword: password });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: BigInt(admin.id) } })).passwordHash).toBe(before.passwordHash);
    expect(await prisma.user.count({ where: { email: { startsWith: 'over-' } } })).toBe(0);
  });

  it('accepts a 72-byte Arabic password through registration and login', async () => {
    const email = 'boundary@test.com';
    const password = 'ع'.repeat(36);
    const created = await request(app).post('/api/auth/register').set(auth(admin.token)).send({ email, password });
    expect(created.status).toBe(201);
    expect((await request(app).post('/api/auth/login').send({ email, password })).status).toBe(200);
  });

  it('allows an existing long-password account to log in and change its password', async () => {
    const email = 'legacy-long@test.com';
    const password = 'ع'.repeat(50);
    // Existing hashes intentionally bypass the NEW-password policy in this fixture.
    await prisma.user.create({ data: { email, role: 'ENGINEER', passwordHash: await bcrypt.hash(password, 12) } });
    const login = await request(app).post('/api/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    const changed = await request(app).post('/api/auth/change-password').set(auth(login.body.data.accessToken))
      .send({ currentPassword: password, newPassword: 'replacement-valid-password' });
    expect(changed.status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'replacement-valid-password' })).status).toBe(200);
  });
});
