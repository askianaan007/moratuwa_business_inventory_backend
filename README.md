# LabLedger API

Backend for the LabLedger inventory and audit system: Express 5, TypeScript, Prisma 7, and PostgreSQL.
The overall plan is in `../moratuwa_frontend/docs/PLAN.md`.

## Quick start

```bash
cp .env.example .env              # then fill in DATABASE_URL, JWT_SECRET, SEED_ADMIN_*
npm install                       # also generates the Prisma client
npm run db:migrate                # create tables
npm run db:seed                   # first admin + demo department/locations
npm run start:dev                 # (or npm run dev) http://localhost:4000/api/v1/health
```

| Script | What it does |
|---|---|
| `npm run start:dev` / `npm run dev` | Start with auto-reload |
| `npm run build` / `npm start` | Production build / run |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:migrate` | Create a migration after editing `prisma/schema.prisma` (dev) |
| `npm run db:deploy` | Apply migrations (production) |
| `npm run db:studio` | Browse the database |

## Structure

```
prisma/
  schema.prisma          data model (see PLAN.md §4)
  migrations/            SQL migrations, committed
  seed.ts
src/
  server.ts              HTTP server + graceful shutdown
  app.ts                 Express app: logging → helmet → CORS → body → rate limit → CSRF → routes → errors
  routes.ts              /api/v1 router: public routes, then `authenticate`, then protected modules
  config/env.ts          env validation (process exits on bad config)
  lib/                   prisma client, logger
  middlewares/           authenticate/authorize, security (CORS, CSRF, rate limits), error handler
  modules/<feature>/     *.routes → *.controller → *.service, with *.schema (Zod)
  utils/                 errors, password hashing, tokens, cookies, department scope, activity log
  generated/prisma/      generated Prisma client (git-ignored)
```

**Conventions**
- Controllers only parse input (Zod), call a service, and shape the response. Business rules live in services.
- Small modules (`users`, `organisation`, `dashboard`) keep handlers in one `*.routes.ts` file. Split them when they grow.
- Every mutation runs in a transaction and writes to `activity_log`.
- Nothing is hard-deleted. Records get `deletedAt` instead.
- Responses: `{ data }` or `{ data, meta }`. Errors: `{ error: { code, message, details?, requestId } }`.

## API (v1)

| Method | Path | Roles |
|---|---|---|
| GET | `/health` | public |
| POST | `/auth/login` · `/auth/refresh` · `/auth/logout` | public |
| GET | `/auth/me` · POST `/auth/change-password` | any signed-in user |
| GET | `/dashboard/summary` | any |
| GET | `/ledger?q&entryType&categoryId&hodSigned&bookStatus&approvalStatus&from&to&page&pageSize` · `/ledger/:id` | any |
| POST | `/ledger` · PATCH/DELETE `/ledger/:id` | Admin, HOD, TO |
| POST | `/ledger/:id/book` (mark written in book) · `/ledger/:id/submit` | Admin, HOD, TO |
| POST | `/ledger/:id/decision` (approve/reject) | Admin, HOD (not their own entry) |
| GET | `/items/by-tag/:tagCode` (QR scan) · `/items/:id` | any |
| PATCH | `/items/:id` · POST `/items/:id/move` | Admin, HOD, TO |
| GET | `/departments` · `/locations` | any (own department) |
| POST | `/locations` | Admin, HOD, TO |
| GET | `/categories?includeInactive` (with per-category ledger totals) | any |
| POST | `/departments` · POST/PATCH `/categories` · GET/POST/PATCH `/users` | Admin |

## Security

| Concern | How it is handled |
|---|---|
| Passwords | scrypt (N=2¹⁵, random salt), strength rules, constant-time compare, dummy hash for unknown emails (no user enumeration) |
| Brute force | 10 failed logins per 15 min per IP+email (rate limit). Account locked for 15 min after 5 wrong passwords. |
| Sessions | 15-min JWT access token + 7-day opaque refresh token, both in `httpOnly`, `SameSite=Strict`, `Secure` (prod) cookies. The refresh cookie is only sent to `/api/v1/auth`. |
| Token theft | Refresh tokens are stored as SHA-256 hashes and rotate on every use. Reusing an old token revokes the whole session family. |
| Revocation | User is re-loaded on every request, so deactivation or role change is immediate. Password change and deactivation sign out all devices. |
| CSRF | SameSite=Strict cookies + Origin allow-list + JSON-only bodies on writes |
| Authorization | Role checks per route. Non-admins are pinned to their own department; other departments' records return 404. |
| Separation of duties | HOD cannot approve their own entry. Approved/submitted entries are locked. |
| Input | Every body, query and param is validated with Zod. Body limit is 200 kB. |
| Headers | helmet (strict CSP, HSTS, frame-deny, no-sniff), `Cache-Control: no-store`, no `X-Powered-By` |
| Errors & logs | Clients never see stack traces. Every response has an `X-Request-Id`. Logs redact cookies, tokens and passwords. |
| Audit trail | Append-only `activity_log` with before/after snapshots |
| Config | The app will not start with a missing or weak `JWT_SECRET` or a bad DB URL |

**Production checklist:** set `NODE_ENV=production` and serve over HTTPS. Set `TRUST_PROXY=1` behind Caddy/Nginx. Use a dedicated database user with a strong password. Schedule daily `pg_dump` backups. Run `npm run db:deploy` on every release. Rate limits are kept in memory, so use a Redis store if you run more than one instance.

## Docker

```bash
docker build -t labledger-api .
docker run --env-file .env -p 4000:4000 labledger-api
```
The image runs as a non-root user. Apply migrations with `npm run db:deploy` before starting a new version.


npx prisma migrate reset --force
npm run db:seed