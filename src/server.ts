import { buildApp } from './app.js';
import { migrate, applyRls } from './db/index.js';
import { seedIfEmpty, ensureFormsCurrent, ensurePlatform, healEmptyTenants } from './db/seed.js';
import { startDispatcher } from './lib/messaging.js';
import { usingObjectStorage } from './lib/storage.js';

await migrate();
await applyRls();
await healEmptyTenants();
await ensurePlatform();
await seedIfEmpty();
await ensureFormsCurrent();
const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
startDispatcher();
console.log(usingObjectStorage() ? `uploads: object storage, bucket ${process.env.S3_BUCKET}` : `uploads: local disk (${process.env.UPLOAD_DIR ?? './data/uploads'})${process.env.NODE_ENV === 'production' ? ' — files will be lost when this host restarts; set S3_* to use object storage' : ''}`);
