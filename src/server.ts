import { buildApp } from './app.js';
import { migrate, applyRls } from './db/index.js';
import { seedIfEmpty, ensureFormsCurrent } from './db/seed.js';

await migrate();
await applyRls();
await seedIfEmpty();
await ensureFormsCurrent();
const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
