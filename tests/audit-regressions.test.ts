import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { app, prisma, request, resetDb, createAdmin, createEngineer, auth } from './helpers';
import { storage } from '../src/services/storage';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
describe('October audit regressions', () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());
  it('uses current role for old access tokens, including optional registration authentication', async () => {
    const admin = await createAdmin();
    await prisma.user.update({ where: { id: BigInt(admin.id) }, data: { role: 'ENGINEER' } });
    expect((await request(app).get('/api/admin/users').set(auth(admin.token))).status).toBe(403);
    expect((await request(app).patch(`/api/admin/users/${admin.id}`).set(auth(admin.token)).send({ role: 'ADMIN' })).status).toBe(403);
    expect((await request(app).post('/api/auth/register').set(auth(admin.token)).send({ email: 'unauthorized@test.com', password: 'password123' })).status).toBe(403);
  });
  it('rejects tokens for deleted accounts', async () => {
    const admin = await createAdmin();
    await prisma.user.delete({ where: { id: BigInt(admin.id) } });
    expect((await request(app).get('/api/admin/users').set(auth(admin.token))).status).toBe(401);
  });
  it('rejects overlong filenames before disk writes and removes saved bytes after DB failure', async () => {
    const admin = await createAdmin();
    const save = vi.spyOn(storage, 'save');
    const rejected = await request(app).post('/api/files').set(auth(admin.token)).attach('file', png, { filename: 'a'.repeat(270) + '.png', contentType: 'image/png' });
    expect(rejected.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
    save.mockResolvedValue({ storedPath: 'synthetic/orphan.png' });
    const remove = vi.spyOn(storage, 'remove').mockResolvedValue();
    vi.spyOn(prisma.file, 'create').mockRejectedValueOnce(new Error('synthetic write failure'));
    expect((await request(app).post('/api/files').set(auth(admin.token)).attach('file', png, 'test.png')).status).toBe(500);
    expect(remove).toHaveBeenCalledWith('synthetic/orphan.png');
  });
  it('prevents owner deletion of archived submission files', async () => {
    const admin = await createAdmin();
    const eng = await createEngineer(admin.token);
    const data = { userId: BigInt(eng.id), fileName: 'report.xlsx', filePath: 'synthetic/report.xlsx', mimeType: 'application/octet-stream', fileSize: 1 };
    const old = await prisma.file.create({ data });
    const current = await prisma.file.create({ data: { ...data, filePath: 'synthetic/current.xlsx' } });
    const sub = await prisma.submission.create({ data: { userId: BigInt(eng.id), fileId: current.id, contractorName: 'test', weekStart: new Date(), weekEnd: new Date(), total: 1, recordsCount: 1 } });
    await prisma.submissionRevision.create({ data: { submissionId: sub.id, revision: 0, fileId: old.id, submittedAt: new Date() } });
    expect((await request(app).delete(`/api/files/${old.id}`).set(auth(eng.token))).status).toBe(403);
    expect(await prisma.file.findUnique({ where: { id: old.id } })).not.toBeNull();
  });
  it('blocks sibling-directory traversal in stored paths', async () => {
    await expect(storage.read('../uploads-elsewhere/secret')).rejects.toThrow('Invalid storage path');
  });
});
