import { prisma } from '../config/prisma';
import { storage } from './storage';
import { pushSubmissionToGoogle } from './googleSheet';

// ═══════════ سلسلة اعتمادات المديرين (داخل التطبيق قبل جوجل شيت) ═══════════
// الكشف بيعدّي على مستويات الاعتماد بالترتيب؛ وبس بعد ما يخلص كلها بيتبعت لجوجل شيت.

const LEVELS_KEY = 'approvalLevels';
export const DEFAULT_LEVELS = ['team leader', 'construction manager', 'project manager'];

// قائمة المستويات المعرّفة (بالترتيب) — من app_config أو الافتراضي
export async function getApprovalLevels(): Promise<string[]> {
  const row = await prisma.appConfig.findUnique({ where: { key: LEVELS_KEY } });
  if (!row?.value) return [...DEFAULT_LEVELS];
  const list = row.value.split('|').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_LEVELS];
}

export async function setApprovalLevels(levels: string[]): Promise<string[]> {
  const clean = levels.map((s) => s.trim()).filter(Boolean).slice(0, 6);
  await prisma.appConfig.upsert({ where: { key: LEVELS_KEY }, update: { value: clean.join('|') }, create: { key: LEVELS_KEY, value: clean.join('|') } });
  return clean;
}

// المستويات "النشطة" = المعرّفة اللي ليها معتمد واحد على الأقل، بترتيب القائمة.
// كده المرونة بتيجي من تعيين الحسابات: مستوى من غير معتمد بيتتخطى تلقائيًا.
export async function getActiveLevels(): Promise<string[]> {
  const levels = await getApprovalLevels();
  const approvers = await prisma.user.findMany({ where: { approvalLevel: { not: null } }, select: { approvalLevel: true } });
  const assigned = new Set(approvers.map((a) => a.approvalLevel as string));
  return levels.filter((l) => assigned.has(l));
}

export function nextLevel(activeLevels: string[], current: string | null): string | null {
  if (!current) return activeLevels[0] ?? null;
  const i = activeLevels.indexOf(current);
  if (i === -1 || i + 1 >= activeLevels.length) return null;
  return activeLevels[i + 1];
}

// دفع الكشف فعليًا لجوجل شيت (بيقرأ الملف من التخزين) — يُستدعى لما السلسلة تخلص
export async function pushSubmissionToSheet(submissionId: bigint): Promise<void> {
  const sub = await prisma.submission.findUnique({ where: { id: submissionId }, include: { file: true, user: { select: { email: true, project: true } } } });
  if (!sub) return;
  const buffer = await storage.read(sub.file.filePath).catch(() => null);
  if (!buffer) { console.error('[approval] ملف التسليم غير موجود عند الدفع لجوجل', submissionId.toString()); return; }
  await pushSubmissionToGoogle(sub.id, buffer, sub.file.fileName, sub.user.email.split('@')[0], sub.user.project ?? null, sub.site);
}

// بدء السلسلة لكشف جديد (أو إعادة إرسال): يحدّد أول مستوى نشط.
// لو مفيش أي مستوى نشط (مفيش معتمدين مضبوطين) → السلوك القديم: يتبعت لجوجل فورًا.
export async function startChain(submissionId: bigint): Promise<{ sentToSheet: boolean; firstLevel: string | null }> {
  const active = await getActiveLevels();
  const first = active[0] ?? null;
  if (!first) {
    await prisma.submission.update({ where: { id: submissionId }, data: { reviewState: 'SENT', currentLevel: null } });
    void pushSubmissionToSheet(submissionId);
    return { sentToSheet: true, firstLevel: null };
  }
  await prisma.submission.update({ where: { id: submissionId }, data: { reviewState: 'IN_REVIEW', currentLevel: first } });
  return { sentToSheet: false, firstLevel: first };
}
