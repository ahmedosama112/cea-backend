import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { hashPassword, verifyPassword } from '../utils/password';
import {
  generateOpaqueToken,
  hashToken,
  passwordResetExpiry,
  refreshTokenExpiry,
  signAccessToken,
} from '../utils/tokens';

interface AuthResult {
  user: { id: string; email: string; role: 'ADMIN' | 'ENGINEER' };
  accessToken: string;
  refreshToken: string;
}

async function issueTokens(user: { id: bigint; email: string; role: 'ADMIN' | 'ENGINEER' }): Promise<AuthResult> {
  const accessToken = signAccessToken({ sub: user.id.toString(), email: user.email, role: user.role });
  const refreshToken = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: refreshTokenExpiry() },
  });
  return {
    user: { id: user.id.toString(), email: user.email, role: user.role },
    accessToken,
    refreshToken,
  };
}

export const authService = {
  // إنشاء الحسابات بمعرفة الأدمن فقط — نفس سياسة النظام القديم (لوحة Supabase).
  // استثناء التمهيد (bootstrap): أول حساب في نظام فاضي يُنشأ بدون أدمن ويصبح ADMIN.
  async register(email: string, password: string, requester?: { role: 'ADMIN' | 'ENGINEER' }): Promise<AuthResult> {
    const userCount = await prisma.user.count();
    if (userCount > 0 && requester?.role !== 'ADMIN') {
      throw AppError.forbidden('إنشاء الحسابات متاح للأدمن فقط');
    }
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) throw AppError.conflict('هذا الإيميل مسجَّل بالفعل');

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: await hashPassword(password),
        role: userCount === 0 ? 'ADMIN' : 'ENGINEER',
      },
    });
    return issueTokens(user);
  },

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // نفس الرسالة سواء الإيميل غير موجود أو كلمة السر غلط — لمنع تعداد الحسابات
    if (!user) throw AppError.unauthorized('الإيميل أو كلمة المرور غير صحيحة');
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw AppError.unauthorized('الإيميل أو كلمة المرور غير صحيحة');
    return issueTokens(user);
  },

  // تدوير التوكن: القديم يُلغى والجديد يُصدر — إعادة استخدام توكن ملغي تكشف سرقة محتملة
  // فتُلغى كل جلسات المستخدم احترازيًا
  async refresh(refreshToken: string): Promise<AuthResult> {
    const tokenHash = hashToken(refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!stored) throw AppError.unauthorized('انتهت الجلسة — سجّل الدخول مرة أخرى');

    if (stored.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw AppError.unauthorized('انتهت الجلسة — سجّل الدخول مرة أخرى');
    }
    if (stored.expiresAt < new Date()) {
      throw AppError.unauthorized('انتهت الجلسة — سجّل الدخول مرة أخرى');
    }

    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return issueTokens(stored.user);
  },

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    // إلغاء صامت — حتى لو التوكن غير موجود، logout ينجح دائمًا
    await prisma.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
  },

  // لا يوجد نظام بريد بعد — التوكن يُعاد في الاستجابة ليتولى الأدمن تسليمه يدويًا للمستخدم.
  // عند ربط SMTP لاحقًا: أرسل التوكن بالبريد وأزل إعادته من الاستجابة.
  async requestPasswordReset(email: string): Promise<{ resetToken: string } | null> {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return null; // استجابة موحّدة في الـ controller لمنع تعداد الحسابات

    const resetToken = generateOpaqueToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(resetToken), expiresAt: passwordResetExpiry() },
    });
    return { resetToken };
  },

  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const stored = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
      throw AppError.unauthorized('رابط الاستعادة غير صالح أو منتهي الصلاحية');
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: stored.userId }, data: { passwordHash: await hashPassword(newPassword) } }),
      prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      // تغيير كلمة السر يُبطل كل الجلسات القائمة
      prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  },

  // الأدمن يعيد تعيين كلمة سر حساب (بدون الحاجة للقديمة) — ويُبطل جلسات الحساب
  async adminSetPassword(userId: bigint, newPassword: string): Promise<void> {
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } }),
      prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  },

  async changePassword(userId: bigint, currentPassword: string, newPassword: string): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) throw AppError.unauthorized('كلمة المرور الحالية غير صحيحة');
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } }),
      prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  },
};
