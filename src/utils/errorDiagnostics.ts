import { Request } from 'express';

// نحتفظ بالرسالة والـstack للتشخيص دون تسلسل كائن الخطأ أو جسم الطلب.
// نحجب بيانات الاعتماد المعروفة من البيئة ومن حقول الطلب الحساسة.
export function errorDiagnostics(err: unknown, req: Request) {
  if (!(err instanceof Error)) return { name: 'UnknownError', kind: typeof err };

  const secrets = new Set<string>();
  function add(value: unknown) {
    if (typeof value === 'string' && value.length >= 8) secrets.add(value);
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (/SECRET|TOKEN|PASSWORD|DATABASE_URL|API_KEY/i.test(name)) add(value);
    if (/DATABASE_URL/i.test(name) && value) {
      try {
        const pw = new URL(value).password;
        add(pw);
        add(decodeURIComponent(pw));
      } catch { /* ليس URL صالحًا */ }
    }
  }
  const authorization = req.get('authorization');
  add(authorization);
  if (authorization?.startsWith('Bearer ')) add(authorization.slice(7));

  const seen = new WeakSet<object>();
  const pending: unknown[] = [req.body, req.query, (err as Error & { body?: unknown }).body];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (/password|token|secret|authorization|api.?key/i.test(key)) add(entry);
      if (entry && typeof entry === 'object') pending.push(entry);
    }
  }

  const values = [...secrets].sort((a, b) => b.length - a.length);
  function redact(text: string) {
    return values.reduce((safe, secret) => safe.split(secret).join('[REDACTED]'), text);
  }
  return { name: redact(err.name), message: redact(err.message), stack: redact(err.stack || `${err.name}: ${err.message}`) };
}
