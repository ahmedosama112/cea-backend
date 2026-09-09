import { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError';
import { WindowKind, windowState } from '../services/windows';

// يمنع الإرسال أو الاعتماد بره الميعاد اللي الأدمن حدده — الحماية هنا مش في الواجهة:
// إخفاء الزرار تحسين شكل، وأي طلب مباشر للـ API كان هيعدّي من غير الحارس ده.
//
// الأدمن مستثنى عن قصد: لو الميعاد اتظبط غلط أو حصل ظرف، لازم يفضل فيه حد يقدر يتصرف
// من غير ما يستنى النافذة الجاية.
export function requireWindow(kind: WindowKind) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());
    if (req.user.role === 'ADMIN') return next();
    try {
      const st = await windowState(kind);
      if (!st.open) return next(AppError.validation(st.reason));
      next();
    } catch (e) {
      next(e);
    }
  };
}
