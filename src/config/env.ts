import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl: required('DATABASE_URL'),

  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  accessTokenTtlMin: Number(process.env.ACCESS_TOKEN_TTL_MIN || 15),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30),
  refreshReuseGraceSec: Number(process.env.REFRESH_REUSE_GRACE_SEC || 120),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),

  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 8),

  rateLimitWindowMin: Number(process.env.RATE_LIMIT_WINDOW_MIN || 15),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 300),
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
};

if (env.nodeEnv === 'production') {
  const insecureDefaults = ['change-this-access-secret-before-production', 'change-this-refresh-secret-before-production'];
  if (insecureDefaults.includes(env.jwtAccessSecret) || insecureDefaults.includes(env.jwtRefreshSecret)) {
    throw new Error('JWT secrets must be changed from their default values before running in production');
  }
}
