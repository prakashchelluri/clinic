# CUBOTT Clinical

Multi-tenant clinic operations app for small Indian clinics. First tenant: Sahitya Dermatology Hospital.
Architecture and product reasoning: [ARCHITECTURE.md](ARCHITECTURE.md).

## What works today (MVP slice 1)

Doctor sets the day's availability and breaks on the Calendar (procedures on the doctor reduce OP capacity automatically) → phone booking with capacity windows → arrival check-in with fee-category suggestion, OP numbering, payment → live queue (reception, doctor, assistant intake) → encounter on a configurable form (dermatology pack) with Rx favourites and "repeat last Rx" → printable A5 prescription → follow-up and procedure recommendations flowing to worklists with contact log → daily collections and expenses report. Multi-tenant with Postgres Row-Level Security.

Also: rooms with capabilities and conflict-checked procedure scheduling, pharmacy counter, document uploads, owner Settings (forms editor, people with multiple roles, fees, medicines, procedures, rooms), platform admin for onboarding clinics.

Not yet: WhatsApp, offline queue, multi-language UI, GST invoices, inventory. See roadmap in ARCHITECTURE.md §8.

## Run locally (no database install needed)

```bash
npm install
npm run dev
```

Open http://localhost:5173. Embedded Postgres (PGlite) is created in `./data` and seeded with the demo clinic on first start.

Demo logins (password `demo1234`, clinic `sahitya`):

| Email | Role |
|---|---|
| owner@demo.clinic | Doctor / owner (all permissions) |
| doctor2@demo.clinic | Second doctor |
| reception@demo.clinic | OP receptionist |
| procedures@demo.clinic | Procedure coordinator |
| assistant@demo.clinic | Assistant (intake before doctor) |
| pharmacy@demo.clinic | Pharmacy counter |
| superadmin@cubott.in | CUBOTT platform admin: onboards clinics (no clinic data access) |

Tests (end-to-end slice + tenant isolation, on embedded Postgres):

```bash
npm test
```

## Deploy free: Render + Neon

1. **Database**: create a free project at neon.tech (pick the Singapore region, nearest to India). Copy the pooled connection string.
2. **App**: push this repo to GitHub, then on render.com choose *New → Blueprint* and point it at the repo. `render.yaml` defines the free web service. Set `DATABASE_URL` to the Neon string when prompted.
3. First boot runs migrations, applies RLS and seeds the demo tenant automatically.

Free-tier caveats: Render free services sleep after 15 minutes idle and take ~30–50 s to wake; Neon free pauses compute when idle (first query after a pause takes a few seconds). Both are fine for demos, not for a live clinic. Production target per ARCHITECTURE.md §4.9: a small VM plus managed Postgres in an Indian region.

### Alternative: Vercel

The server is a long-running Fastify process (needed later for the job queue and WhatsApp webhooks), so Vercel's serverless model is not the right fit. If you must use Vercel, host only `web/` there and point the API proxy at a Render service.

## Layout

```
src/
  app.ts            Fastify app: auth cookie, permission check, static PWA
  server.ts         migrate → RLS → seed → listen
  db/schema.ts      Drizzle schema (tenant_id on every row)
  db/index.ts       driver switch (Postgres / PGlite), withTenant(), applyRls()
  db/seed.ts        demo tenant + dermatology pack
  lib/              auth (scrypt, roles), route helper, numbering, events
  modules/          identity, patients, scheduling, visits (queue), clinical, billing
web/                React + Vite + Tailwind PWA
test/smoke.test.ts  end-to-end slice
drizzle/            generated SQL migrations (npm run db:generate after schema changes)
```

Config that is data, not code: fee categories and eligibility rules (JSONLogic), encounter and intake forms, medicines with defaults, procedure catalogue, OP windows and capacity, numbering scope, print header, role permission bundles (`tenant.settings.roles`).

## Sample data

Sign in as the owner and call the loader once (it refuses to run twice):

```bash
curl -c cj -X POST http://localhost:4000/api/auth/login -H "content-type: application/json" -d "{\"email\":\"owner@demo.clinic\",\"password\":\"demo1234\"}" && curl -b cj -X POST http://localhost:4000/api/dev/sample-data
```

It creates 26 Rajahmundry patients with months of history, today's bookings and a live queue in mixed states, completed encounters with prescriptions, procedure and follow-up worklist items with call logs, payments and expenses. Delete the `data` folder and restart to start clean.
