import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { newPasswordSchema } from '../schema/auth.schema';

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(newPasswordSchema.parse(plain), env.bcryptRounds);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
