import { buildApp } from './app.js';
import { migrate, applyRls } from './db/index.js';
import { seedIfEmpty, ensureFormsCurrent, ensurePlatform, healEmptyTenants } from './db/seed.js';
import { startDispatcher } from './lib/messaging.js';

await migrate();
await applyRls();
await healEmptyTenants();
await ensurePlatform();
await seedIfEmpty();
await ensureFormsCurrent();
const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
startDispatcher();
