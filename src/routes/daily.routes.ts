import { Router } from 'express';
import { Request, Response } from 'express';
import { dailyService } from '../services/daily.service';
import { authenticate } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { idParamSchema } from '../utils/crudFactory';
import { dailyCreateSchema, dailyUpdateSchema } from '../schema/items.schema';

export const dailyRoutes = Router();
dailyRoutes.use(authenticate);

dailyRoutes.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await dailyService.list(req.user!.id) });
  }),
);
dailyRoutes.post(
  '/',
  validate({ body: dailyCreateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await dailyService.create(req.user!.id, req.body) });
  }),
);
dailyRoutes.put(
  '/:id',
  validate({ params: idParamSchema, body: dailyUpdateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await dailyService.update(req.user!.id, BigInt(req.params.id), req.body) });
  }),
);
dailyRoutes.delete(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await dailyService.remove(req.user!.id, BigInt(req.params.id));
    res.json({ success: true, data: null });
  }),
);
