import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// (L2) رقم من البيئة مع فشل صريح عند الإقلاع لو القيمة مش رقم (مثلاً "15m" → كانت NaN بصمت
// فيكسر كل تسجيل دخول بـ 500 بدون سبب واضح)
function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Env var ${name} must be a number, got: "${raw}"`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: num('PORT', 4000),
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl: required('DATABASE_URL'),

  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  accessTokenTtlMin: num('ACCESS_TOKEN_TTL_MIN', 15),
  refreshTokenTtlDays: num('REFRESH_TOKEN_TTL_DAYS', 30),
  refreshReuseGraceSec: num('REFRESH_REUSE_GRACE_SEC', 120),
  bcryptRounds: num('BCRYPT_ROUNDS', 12),

  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads'),
  maxUploadMb: num('MAX_UPLOAD_MB', 8),

  rateLimitWindowMin: num('RATE_LIMIT_WINDOW_MIN', 15),
  rateLimitMax: num('RATE_LIMIT_MAX', 300),
  authRateLimitMax: num('AUTH_RATE_LIMIT_MAX', 20),
};

if (env.nodeEnv === 'production') {
  // (L1) مش كفاية رفض القيم الافتراضية — أي سر أقصر من 32 حرف مرفوض في الإنتاج
  if (env.jwtAccessSecret.length < 32 || env.jwtRefreshSecret.length < 32) {
    throw new Error('JWT secrets must be at least 32 characters in production');
  }
}
