import { mkdirSync, writeFileSync, createReadStream, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Where uploaded files (clinical photos, reports) live. Object storage (Cloudflare R2 or any S3-compatible store)
 * when S3_BUCKET and keys are set, so files survive restarts on hosts with throwaway disks; local disk otherwise.
 * Keys look like <tenantId>/<patientId>/<documentId>.<ext> in both, so moving between them is a copy.
 */
const ROOT = process.env.UPLOAD_DIR ?? './data/uploads';
const bucket = process.env.S3_BUCKET;
export const usingObjectStorage = () => !!(bucket && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);

let client: any = null;
async function s3() {
  if (client) return client;
  const { S3Client } = await import('@aws-sdk/client-s3'); // loaded only when configured
  client = new S3Client({
    region: process.env.S3_REGION ?? 'auto', // R2 uses "auto"
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' || undefined,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  return client;
}

export async function putFile(key: string, bytes: Buffer, mime: string) {
  if (usingObjectStorage()) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3()).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mime }));
    return;
  }
  const file = path.join(ROOT, key); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes);
}

/** A readable stream of the file, or null when it is not there. Falls back to local disk for files saved before object storage was switched on. */
export async function getFile(key: string): Promise<Readable | null> {
  if (usingObjectStorage()) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try { const r = await (await s3()).send(new GetObjectCommand({ Bucket: bucket, Key: key })); return r.Body as Readable; }
    catch (e: any) { if (!(e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404)) throw e; }
  }
  const file = path.join(ROOT, key);
  return existsSync(file) ? createReadStream(file) : null;
}

export async function deleteFile(key: string) {
  if (usingObjectStorage()) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3()).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  rmSync(path.join(ROOT, key), { force: true });
}
