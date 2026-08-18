import { Router } from 'express';
import { accountController, accountSettingsSchema } from '../controllers/account.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';

export const accountRoutes = Router();
accountRoutes.use(authenticate);

// المهندس يقرأ إعداداته (PIN hash / توقيع) فقط — الكتابة للأدمن حصريًا،
// سواء لنفسه هنا أو لحساب مهندس عبر /api/admin/users/:userId/settings
accountRoutes.get('/settings', accountController.get);
accountRoutes.put('/settings', requireRole('ADMIN'), validate({ body: accountSettingsSchema }), accountController.update);
