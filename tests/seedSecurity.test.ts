import crypto from 'crypto';
import { spawnSync } from 'child_process';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDb } from './helpers';

function runSeed(password: string) {
  return spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'prisma/seed.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 25000,
    env: { ...process.env, SEED_ADMIN_EMAIL: 'seed-security@test.com', SEED_ADMIN_PASSWORD: password },
  });
}

describe('Secure first-admin seeding', () => {
  beforeAll(async () => { await resetDb(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('requires a supplied password instead of generating and printing one', async () => {
    const result = runSeed('');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SEED_ADMIN_PASSWORD');
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects an overlong password without printing its value', async () => {
    const password = crypto.randomBytes(40).toString('hex');
    const result = runSeed(password);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(password);
    expect(await prisma.user.count()).toBe(0);
  });

  it('creates an admin with a valid supplied password without echoing it', async () => {
    const password = crypto.randomBytes(20).toString('hex');
    const result = runSeed(password);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(password);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'seed-security@test.com' } });
    expect(admin.role).toBe('ADMIN');
    expect(await bcrypt.compare(password, admin.passwordHash)).toBe(true);
  });
});
