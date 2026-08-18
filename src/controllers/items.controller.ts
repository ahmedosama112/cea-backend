import { Request, Response } from 'express';
import { itemsService, itemToApiShape } from '../services/items.service';
import { execService } from '../services/exec.service';
import { asyncHandler } from '../utils/asyncHandler';

export const itemsController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await itemsService.list(req.user!.id) });
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    const row = await itemsService.getOwned(req.user!.id, BigInt(req.params.id));
    res.json({ success: true, data: itemToApiShape(row) });
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await itemsService.create(req.user!.id, req.body) });
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await itemsService.update(req.user!.id, BigInt(req.params.id), req.body) });
  }),
  remove: asyncHandler(async (req: Request, res: Response) => {
    await itemsService.remove(req.user!.id, BigInt(req.params.id));
    res.json({ success: true, data: null });
  }),
};

export const execController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await execService.list(req.user!.id) });
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await execService.create(req.user!.id, req.body) });
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await execService.update(req.user!.id, BigInt(req.params.id), req.body) });
  }),
  remove: asyncHandler(async (req: Request, res: Response) => {
    await execService.remove(req.user!.id, BigInt(req.params.id));
    res.json({ success: true, data: null });
  }),
};
