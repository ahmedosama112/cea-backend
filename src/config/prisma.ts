import { PrismaClient } from '@prisma/client';
import { env } from './env';

export const prisma = new PrismaClient({
  log: env.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
});

// BigInt IDs (Record/Contractor/... primary keys) لا يمكن تسلسلها بـ JSON.stringify افتراضيًا —
// نحوّلها لنص عند التسلسل بدل تعطيل النوع في Prisma schema بالكامل.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
