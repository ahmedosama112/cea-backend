import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { filesController } from '../controllers/files.controller';
import { authenticate } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1 },
});

export const filesRoutes = Router();
filesRoutes.use(authenticate);

filesRoutes.post('/', upload.single('file'), filesController.upload);
filesRoutes.get('/:id', validate({ params: idParamSchema }), filesController.meta);
filesRoutes.get('/:id/content', validate({ params: idParamSchema }), filesController.content);
filesRoutes.delete('/:id', validate({ params: idParamSchema }), filesController.remove);
