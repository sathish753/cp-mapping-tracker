# CP / Workstation Ledger

A Node.js + Express web app for maintaining the employee ↔ workstation ↔ CP mapping
register, with three role-based logins and a built-in audit dashboard.
**No external database** — all data is stored in a single JSON file on disk
(`data/db.json`), which is created automatically the first time the server runs.

## Table fields
S.No, Employee Name, Employee ID, Block, Workstation Number, CP Name,
Process Name, Client Name, TL Name, OM Name.

## Roles

| Role  | Can view all records | Can create / delete records | Can edit |
|-------|:---:|:---:|---|
| Admin | ✅ | ✅ | All fields, including mapping any of the above |
| OM    | ✅ | ❌ | Everything except Block, Workstation Number, OM Name, and CP Name |
| TL    | ✅ | ❌ | Employee Name, Employee ID, Process Name, Client Name |

Field-level permission is enforced on the **server**, not just hidden in the UI —
an OM or TL account cannot push a change to a field it isn't allowed to touch,
even by calling the API directly.

## Change dashboard
Every time **CP Name**, **Employee Name** or **Employee ID** is changed on a
record, an audit entry is written with the old value, new value, who made the
change, their role and a timestamp. The "Change Dashboard" tab shows:
- totals (records, tracked interchanges, changes today, all changes)
- a breakdown of interchanges by field
- the S.No entries that have been re-assigned the most
- a full audit trail table with before → after values

## Getting started (local)

```bash
npm install
npm start
```

The server starts on `http://localhost:3000` (or `PORT` from the environment).

### Demo logins (change these immediately in a real deployment)

| Role  | Username | Password |
|-------|----------|----------|
| Admin | admin    | admin123 |
| OM    | om1      | om123    |
| TL    | tl1      | tl123    |

Once logged in as Admin, go to **Manage Logins** to create real accounts and
remove the demo ones.

## Deploying

This is a plain Node/Express app — deploy it anywhere that runs Node.js
(a VPS, Render, Railway, an on-prem server, etc.):

1. Copy the project to the server (excluding `node_modules` and `data/db.json`).
2. `npm install --production`
3. Set a real session secret: `export SESSION_SECRET="something-long-and-random"`
4. `npm start` (or run it under a process manager like `pm2` / `systemd` so it
   restarts automatically).
5. Point a reverse proxy (nginx / Caddy) at the app's port if you need HTTPS
   on a domain.

### Persisting data
All data lives in `data/db.json`. **Back this file up regularly** — it is the
entire database. Since it's a single file, avoid running multiple instances
of the app against the same `data/` folder behind a load balancer; run one
Node process (pm2's cluster mode would cause writes to race).

## Running with Docker

A `Dockerfile` and `docker-compose.yml` are included.

**Quickest path (docker compose):**
```bash
docker compose up -d --build
```
This builds the image, starts the container, maps port 3000, and creates a
named volume (`cp-tracker-data`) so `data/db.json` survives rebuilds and
restarts. Open `http://localhost:3000`.

**Plain Docker, without compose:**
```bash
docker build -t cp-tracker .
docker run -d --name cp-tracker \
  -p 3000:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v cp-tracker-data:/app/data \
  cp-tracker
```

**Important — HTTPS and cookies:** don't set `NODE_ENV=production` until this
container is genuinely served over HTTPS (e.g. behind an nginx/Caddy/Traefik
reverse proxy). The app marks its session cookie `secure` in production mode,
and browsers refuse to send secure cookies back over plain HTTP — so turning
this on too early makes logins silently fail to persist. Leave it unset for
local/plain-HTTP use.

Always set your own `SESSION_SECRET` for anything beyond local testing — the
image ships with a default fallback secret that is not safe to use in
production.

## Project structure
```
cp-tracker/
├── server.js        # Express app, auth, permissions, API routes
├── db.js             # JSON-file data layer (the "built-in DB")
├── data/db.json       # created automatically on first run
├── public/
│   ├── index.html    # SPA shell (login + records + dashboard + users)
│   ├── style.css
│   └── app.js         # frontend logic (fetch calls to the API)
└── package.json
```
