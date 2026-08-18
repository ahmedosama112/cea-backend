import { Router } from 'express';
import { execController, itemsController } from '../controllers/items.controller';
import { authenticate } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { idParamSchema } from '../utils/crudFactory';
import { execCreateSchema, execUpdateSchema, itemCreateSchema, itemUpdateSchema } from '../schema/items.schema';

export const itemsRoutes = Router();
itemsRoutes.use(authenticate);
itemsRoutes.get('/', itemsController.list);
itemsRoutes.get('/:id', validate({ params: idParamSchema }), itemsController.get);
itemsRoutes.post('/', validate({ body: itemCreateSchema }), itemsController.create);
itemsRoutes.put('/:id', validate({ params: idParamSchema, body: itemUpdateSchema }), itemsController.update);
itemsRoutes.delete('/:id', validate({ params: idParamSchema }), itemsController.remove);

export const execRoutes = Router();
execRoutes.use(authenticate);
execRoutes.get('/', execController.list);
execRoutes.post('/', validate({ body: execCreateSchema }), execController.create);
execRoutes.put('/:id', validate({ params: idParamSchema, body: execUpdateSchema }), execController.update);
execRoutes.delete('/:id', validate({ params: idParamSchema }), execController.remove);
