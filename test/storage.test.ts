// Uploads go to S3-compatible object storage when configured (Cloudflare R2 in production). A tiny fake S3 stands in for R2.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { rmSync, existsSync, readdirSync } from 'node:fs';

const store = new Map<string, { body: Buffer; type: string }>();
const seen: string[] = [];
const fake: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const key = decodeURIComponent((req.url ?? '').split('?')[0]);
    seen.push(`${req.method} ${key} ${req.headers.authorization?.startsWith('AWS4-HMAC-SHA256') ? 'signed' : 'unsigned'}`);
    if (req.method === 'PUT') { store.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) }); res.writeHead(200, { etag: '"x"' }); return res.end(); }
    if (req.method === 'GET') {
      const o = store.get(key);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>'); }
      res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length }); return res.end(o.body);
    }
    if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
const port = (fake.address() as any).port;

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-storage';
process.env.UPLOAD_DIR = './data/test-uploads-storage';
process.env.COOKIE_SECRET = 'test-secret';
process.env.S3_BUCKET = 'cubott';
process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.S3_ACCESS_KEY_ID = 'test-key';
process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } });

before(async () => {
  await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp();
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@demo.clinic', password: 'demo1234', tenant: 'sahitya' } });
  cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
});
after(async () => { await app.close(); fake.close(); });

test('uploads, downloads and deletes go to object storage, signed, and never touch local disk', async () => {
  const p = (await call('POST', '/patients', { fullName: 'Storage Patient', phone: '9000077777' })).json();
  const pdf = Buffer.from('%PDF-1.4\n% test report\n');
  const up = await call('POST', '/documents', { patientId: p.id, kind: 'report', title: 'CBC report.pdf', mime: 'application/pdf', dataBase64: pdf.toString('base64') });
  assert.equal(up.statusCode, 200, up.body);
  const doc = up.json();
  const key = `/cubott/${doc.storageKey}`;
  assert.ok(store.has(key), 'object written to the bucket under the document key');
  assert.equal(store.get(key)!.type, 'application/pdf');
  assert.ok(seen.some((s) => s.startsWith('PUT') && s.endsWith('signed')), 'requests are signed');
  assert.ok(!existsSync(process.env.UPLOAD_DIR!) || readdirSync(process.env.UPLOAD_DIR!).length === 0, 'nothing written to local disk');

  const get = await call('GET', `/documents/${doc.id}/file`);
  assert.equal(get.statusCode, 200); assert.equal(get.headers['content-type'], 'application/pdf'); assert.equal(get.rawPayload.toString(), pdf.toString());

  // object gone from the bucket → clear 404, not a crash
  const saved = store.get(key)!; store.delete(key);
  const missing = await call('GET', `/documents/${doc.id}/file`);
  assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, 'FILE_MISSING');
  store.set(key, saved);

  assert.equal((await call('DELETE', `/documents/${doc.id}`)).statusCode, 200);
  assert.ok(!store.has(key), 'deleting the record deletes the object');
});

test('a storage failure leaves no orphan record', async () => {
  const p = (await call('POST', '/patients', { fullName: 'Outage Patient', phone: '9000088888' })).json();
  fake.close(); fake.closeAllConnections?.();
  const up = await call('POST', '/documents', { patientId: p.id, kind: 'report', title: 'x.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4').toString('base64') });
  assert.equal(up.statusCode, 500);
  const docs = (await call('GET', `/patients/${p.id}/documents`)).json();
  assert.equal(docs.length, 0, 'the record was rolled back with the failed upload');
});
