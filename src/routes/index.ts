import { Router } from 'express';
import { adminRoutes } from './admin.routes';
import { authRoutes } from './auth.routes';
import { accountRoutes } from './account.routes';
import { dailyRoutes } from './daily.routes';
import { filesRoutes } from './files.routes';
import { execRoutes, itemsRoutes } from './items.routes';
import { recordsRoutes } from './records.routes';
import { contractorsRouter, inspectorsRouter, irRouter, placesRouter, todosRouter } from './entities.routes';

export const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/account', accountRoutes);
router.use('/contractors', contractorsRouter);
router.use('/places', placesRouter);
router.use('/inspectors', inspectorsRouter);
router.use('/items', itemsRoutes);
router.use('/records', recordsRoutes);
router.use('/ir-records', irRouter);
router.use('/todos', todosRouter);
router.use('/exec-records', execRoutes);
router.use('/daily-records', dailyRoutes);
router.use('/files', filesRoutes);
