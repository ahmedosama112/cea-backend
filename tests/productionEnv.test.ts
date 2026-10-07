import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';

const example = dotenv.parse(fs.readFileSync(path.resolve('.env.example')));
type SecretName = 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET';

function loadEnv(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', 'require("./src/config/env")'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: crypto.randomBytes(48).toString('hex'),
      JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'),
      ...overrides,
    },
  });
}

describe('Production JWT configuration', () => {
  it.each<SecretName>(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])('rejects a short %s without disclosing it', (name) => {
    const value = crypto.randomBytes(8).toString('hex');
    const result = loadEnv({ [name]: value });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('JWT secrets must be at least 32 characters');
    expect(result.stderr).not.toContain(value);
  });

  it.each<SecretName>(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])('rejects the example %s', (name) => {
    const result = loadEnv({ [name]: example[name] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Replace example JWT secrets');
    expect(result.stderr).not.toContain(example[name]);
  });

  it('also rejects the example secrets when swapped', () => {
    const result = loadEnv({
      JWT_ACCESS_SECRET: example.JWT_REFRESH_SECRET,
      JWT_REFRESH_SECRET: example.JWT_ACCESS_SECRET,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Replace example JWT secrets');
  });

  it('accepts independently generated long production secrets', () => {
    expect(loadEnv().status).toBe(0);
  });

  it('keeps example secrets usable for development only', () => {
    expect(loadEnv({
      NODE_ENV: 'development',
      JWT_ACCESS_SECRET: example.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: example.JWT_REFRESH_SECRET,
    }).status).toBe(0);
  });
});
