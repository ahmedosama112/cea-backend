import { describe, test, expect } from 'e2e';
import { api, createEngineer, download, loginAdmin, PNG_BYTES, upload, type Session } from './helpers';

// الملفات (صور التوقيع والتقارير اليومية): صور بس، ومحدش يوصل لملف غيره
describe('الملفات', { serial: true }, () => {
  let owner: Session;
  let stranger: Session;
  let fileId: string;

  test('رفع صورة PNG بيرجّع بيانات الملف', async () => {
    const admin = (await loginAdmin()).token;
    owner = await createEngineer(admin, 'files-owner');
    stranger = await createEngineer(admin, 'files-stranger');
    const res = await upload('POST', '/api/files', { token: owner.token, file: { name: 'توقيع.png', type: 'image/png', bytes: PNG_BYTES } });
    expect(res.status).toBe(201);
    expect(res.body.data.mimeType).toBe('image/png');
    expect(res.body.data.fileName).toBe('توقيع.png');
    fileId = String(res.body.data.id);
  });

  test('ملف مش صورة بيترفض — بالنوع وبالمحتوى', async () => {
    const pdf = await upload('POST', '/api/files', { token: owner.token, file: { name: 'x.pdf', type: 'application/pdf', bytes: new Uint8Array(32) } });
    expect(pdf.status).toBe(400);
    // اسمه png ونوعه image/png لكن محتواه مش صورة
    const fake = await upload('POST', '/api/files', { token: owner.token, file: { name: 'fake.png', type: 'image/png', bytes: new Uint8Array(32) } });
    expect(fake.status).toBe(400);
  });

  test('صاحب الملف يقرا بياناته ومحتواه زي ما اترفع', async () => {
    const meta = await api('GET', `/api/files/${fileId}`, { token: owner.token });
    expect(meta.status).toBe(200);
    const content = await download(`/api/files/${fileId}/content`, owner.token);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toContain('image/png');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG_BYTES);
  });

  test('مستخدم تاني ياخد 404 (مش 403 — ما نكشفش إن الملف موجود) وما يقدرش يحذفه', async () => {
    expect((await api('GET', `/api/files/${fileId}`, { token: stranger.token })).status).toBe(404);
    expect((await download(`/api/files/${fileId}/content`, stranger.token)).status).toBe(404);
    expect((await api('DELETE', `/api/files/${fileId}`, { token: stranger.token })).status).toBe(404);
  });

  test('صاحب الملف يحذفه وبعدها 404', async () => {
    const del = await api('DELETE', `/api/files/${fileId}`, { token: owner.token });
    expect(del.status).toBe(200);
    expect((await api('GET', `/api/files/${fileId}`, { token: owner.token })).status).toBe(404);
  });
});
