import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  sub: string; // user id (string لأن الـ id في DB هو BigInt)
  email: string;
  role: 'ADMIN' | 'ENGINEER';
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: `${env.accessTokenTtlMin}m` });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.jwtAccessSecret) as AccessTokenPayload;
}

// Refresh tokens وpassword-reset tokens: قيمة عشوائية تُرسل للعميل، ويُخزَّن الـ hash فقط في DB
// (لو تسرّبت قاعدة البيانات، التوكنات الفعلية غير قابلة لإعادة الاستخدام)
export function generateOpaqueToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshTokenExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + env.refreshTokenTtlDays);
  return d;
}

export function passwordResetExpiry(): Date {
  const d = new Date();
  d.setHours(d.getHours() + 1); // ساعة واحدة فقط لصلاحية رابط استعادة كلمة السر
  return d;
}
