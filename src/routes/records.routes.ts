import { Router } from 'express';
import { recordsController } from '../controllers/records.controller';
import { authenticate } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';
// PUT يستخدم recordCreateSchema الكامل عمدًا — الواجهة الحالية تعيد إرسال السجل كاملًا عند التعديل (saveRecord)
import { recordCreateSchema, recordListQuerySchema } from '../schema/records.schema';

export const recordsRoutes = Router();
recordsRoutes.use(authenticate);

recordsRoutes.get('/', validate({ query: recordListQuerySchema }), recordsController.list);
recordsRoutes.get('/:id', validate({ params: idParamSchema }), recordsController.get);
recordsRoutes.post('/', validate({ body: recordCreateSchema }), recordsController.create);
recordsRoutes.put('/:id', validate({ params: idParamSchema, body: recordCreateSchema }), recordsController.update);
recordsRoutes.patch('/:id/toggle-done', validate({ params: idParamSchema }), recordsController.toggleDone);
recordsRoutes.delete('/:id', validate({ params: idParamSchema }), recordsController.remove);
