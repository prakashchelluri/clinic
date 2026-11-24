import { buildApp } from './app.js';
import { sql } from 'drizzle-orm';
import { db, migrate, applyRls, warmPool } from './db/index.js';
import { seedIfEmpty, ensureFormsCurrent, ensurePlatform, healEmptyTenants } from './db/seed.js';
import { startDispatcher } from './lib/messaging.js';
import { usingObjectStorage } from './lib/storage.js';

await migrate();
await applyRls();
// how close to the database's connection limit we are (Aiven's free plan has few): shown in Render's log at each start
await db.execute(sql`select current_setting('max_connections')::int as max, (select count(*)::int from pg_stat_activity where datname = current_database()) as used`)
  .then((r: any) => { const x = (r.rows ?? r)[0]; console.log(`database: ${x.used} of ${x.max} connections in use (this server takes up to ${process.env.DATABASE_POOL || 5})`); })
  .catch(() => {});
await healEmptyTenants();
await ensurePlatform();
await seedIfEmpty();
await ensureFormsCurrent();
const app = await buildApp();
await warmPool().catch((e) => console.warn('could not open the database connections early', (e as Error).message)); // the first screen does not pay for them
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
startDispatcher();
console.log(usingObjectStorage() ? `uploads: object storage, bucket ${process.env.S3_BUCKET}` : `uploads: local disk (${process.env.UPLOAD_DIR ?? './data/uploads'})${process.env.NODE_ENV === 'production' ? ' — files will be lost when this host restarts; set S3_* to use object storage' : ''}`);
