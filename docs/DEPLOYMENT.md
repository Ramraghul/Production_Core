# Deployment

The application is a **single container with no external dependencies** — no
database, no message broker, no sidecar. That is what makes a genuinely free
deployment possible, and it is why the store is in-process and the MQTT broker
is embedded.

## The constraint that shapes everything

Free hosting tiers give you an **ephemeral disk**. Anything written is lost on
the next cold start, and cold starts happen — on idle timeout, on a platform
restart, on a redeploy.

So every deployment config sets `PC_STORE=memory` and lets the plant reseed
deterministically on each boot. That is a deliberate design choice, not a
limitation worked around:

- The seeder is **deterministic** — a given `PC_SIM_SEED` produces the same
  plant every time, so the demo looks identical on every restart.
- The seeder **always produces a populated plant**. A naive backfill produces
  nothing if the current shift began two minutes ago, and a cold start lands
  shortly after a shift change roughly one time in eight. The seeder keeps
  reaching further back until it has history, and lets work in progress carry
  across shift boundaries the way a real line does. Verified across all 96
  half-hourly boot moments in a day.
- Memory is **bounded**. Time-series collections are capped ring buffers, so a
  long-running instance does not grow until it is OOM-killed.

Measured footprint: ~36 KB per vehicle, ~160 MB RSS for a three-shift backfill
with Node-RED loaded. Comfortable inside a 512 MB instance.

---

## Render — recommended

Free indefinitely. Spins down after 15 minutes without traffic; the first
request after that waits ~50 s for a cold start.

1. Push the repository to GitHub.
2. In Render: **New +** → **Blueprint**, point it at the repository.
3. Render reads [`render.yaml`](../render.yaml) and provisions the service. No
   dashboard configuration needed.

The blueprint sets `PC_STORE=memory`, seeds three shifts, runs the simulator in
real time, serves the flow editor read-only, and wires `RENDER_EXTERNAL_URL` into
`PC_PUBLIC_URL` so the OpenAPI document lists the real public server rather than
only a relative path.

`healthCheckPath` is `/api/v1/ready`, which returns 503 until the plant model is
loaded — so Render does not route traffic to a half-started instance.

**Change the API key.** `production-core-demo-key` is in the repository. Set
`PC_API_KEY` in the Render dashboard if you would rather it not be public.

### The cold start

A free Render service that has been idle shows a blank page for ~50 s while the
container starts. If you are sending someone a link to look at, open it yourself
a minute beforehand.

---

## Vercel — serverless

Free on the Hobby plan (personal, non-commercial projects — a portfolio fits).
Vercel runs **functions**, not servers: there is no long-lived process and no
TCP port, and an instance is frozen between requests. So the Vercel deployment
is the application **minus the two parts that need a process of their own**:

| | On Vercel | Why |
|---|---|---|
| Plant HMI (`/`) | Yes — served from the CDN | Static files in `public/` |
| Swagger UI (`/api-docs`) | Yes — served from the CDN | Copied into `public/api-docs/` at build time |
| REST API, `/openapi.json` | Yes | One function, [`api/index.js`](../api/index.js) |
| Docs site (`/docs`) | Yes | Same function |
| Live event stream | Yes, reconnecting every 50 s | A function has a maximum duration |
| Simulator | Yes, advanced by requests | See below |
| Node-RED (`/red`, `/factory`) | **No** | A runtime with its own event loop and editor |
| MQTT broker | **No** | A TCP listener |

### Deploy

1. Push the repository to GitHub.
2. In Vercel: **Add New… → Project**, import the repository.
3. Leave every setting at its default — [`vercel.json`](../vercel.json) supplies
   them — and press **Deploy**.

Or from a terminal, with the [Vercel CLI](https://vercel.com/docs/cli):

```bash
npm install -g vercel
vercel          # a preview deployment
vercel --prod   # production
```

To see exactly what the deployment serves before pushing — no account needed:

```bash
npm run start:serverless    # http://localhost:3000
```

It reproduces Vercel's routing for this app (static files, then the rewrites,
then the function) around the real `api/index.js`.

No environment variables are required: Vercel sets `VERCEL=1`, and the
configuration switches to serverless defaults on its own (memory store,
Node-RED and MQTT off, request-driven simulator). The optional ones:

| Variable | Why you would set it |
|---|---|
| `PC_API_KEY` | So the write key is not the one published in this repository |
| `PC_FULL_RUNTIME_URL` | The address of a full deployment (Render, say). `/red` and `/factory` then redirect there instead of explaining that they are not on Vercel |
| `PC_RATE_LIMIT_WRITES` | Writes per minute per client IP; default 120 |

### How it fits together

- **`vercel.json`** sets `"framework": null`. Without it Vercel spots Express in
  `package.json`, treats `src/index.js` as the server and tries to run the full
  runtime — Node-RED and all — as a function.
- **Static first.** `public/` is the output directory, so the HMI and its assets
  come straight from the CDN. Every other path is rewritten to the one function.
- **Swagger UI is static too.** `npm run vercel-build` copies the three
  `swagger-ui-dist` files and the page into `public/api-docs/`. Served by the
  function instead, they would be missing: Vercel bundles the files a function
  `require`s, and Swagger's stylesheet and bundles are read from a directory
  computed at runtime, which the bundler cannot follow — the usual reason a
  Swagger page on Vercel comes up blank or unstyled.
- **`includeFiles`** adds what the function reads from disk at runtime — the
  markdown for `/docs` and the files the docs' source browser shows.
- **Nothing heavy is bundled.** The serverless entry never loads Node-RED or the
  MQTT broker, so the function carries neither. A test checks this in a separate
  process.

### The simulator on a frozen instance

A timer does not run while an instance is frozen. So each API request first
**replays the ticks it missed**, up to 30 seconds' worth
(`PC_SIM_CATCH_UP_SECONDS`). A longer gap is skipped rather than replayed: ten
idle minutes squeezed into one request would be slow, and would stamp ten
minutes of output onto a single instant, which the KPIs would read as an
impossible burst. The plant therefore runs while someone is watching and pauses
while nobody is — honest, if not a real plant.

### What to expect

- **A cold start reseeds the plant**, deterministically: three shifts in about
  half a second, plus module loading. Anything a visitor changed is gone
  afterwards — the same trade-off as Render's free tier.
- **Instances do not share state.** Under load Vercel can run more than one,
  and a station stopped on one is still running on another. At demo traffic a
  single instance usually serves everything; a shared store is what fixes it
  properly (see below).
- **The rate limit is per instance**, for the same reason.

### Does it need a database?

**No.** Nothing in this deployment depends on one: the store is in memory and
reseeds itself, which is the design, not a gap. A database becomes worth having
only if changes must survive cold starts and be shared across instances.

If you get there, use **Neon** (serverless Postgres) from Vercel's marketplace:

- The data is documents — vehicles, genealogy trees, defects — and Postgres
  `JSONB` stores them as they are, while recall queries by lot stay plain SQL
  with an index.
- It has a serverless driver built for functions, and a free tier that suspends
  an idle database rather than deleting it.
- It is the step [Architecture](ARCHITECTURE.md#where-it-would-go-next) already
  plans: Postgres behind the existing repository interface.

MongoDB Atlas would also fit the document shape. The others are the wrong tool
here: Redis/Upstash and Edge Config are key-value stores, Blob is file storage,
MotherDuck is analytics, Mem0 is memory for AI agents, and Convex is a whole
backend with its own functions model. Supabase is Postgres too, but pauses free projects
that go quiet, which does not suit a demo that must stay up.

Adopting any of them is real work, not configuration: the repository is
synchronous and in-process today, and a network store makes every read async.

---

## Hugging Face Spaces

Free indefinitely, and **no spin-down on request** — a Space stays warm and is
only paused after 48 hours with no traffic at all. For a portfolio link someone
might open at any time, this is usually the better experience than Render.

1. Create a new Space, **SDK = Docker**.
2. Copy `deploy/huggingface/Dockerfile` to the Space repository root as
   `Dockerfile`.
3. Copy `deploy/huggingface/README.md` to the Space root as `README.md` — its
   YAML front matter is what configures the Space (title, emoji, `app_port`).
4. Copy the rest of the project alongside them, or add the Space as a git remote
   and push.

Spaces requires the app to listen on **port 7860** and runs the container as a
non-root user; the provided Dockerfile handles both.

---

## Koyeb

Free "nano" instance, one service on the free plan.

1. **Create Service** → **Docker** → point at the repository (Koyeb builds from
   the root `Dockerfile`).
2. Set the port to `1880`, health check path `/api/v1/ready`.
3. Environment: `PC_STORE=memory`, `PC_SEED_SHIFTS=3`, `PC_EDITOR_READONLY=true`.

---

## Fly.io

[`fly.toml`](../fly.toml) is included, but **check Fly's current pricing** before
assuming it is free — their free allowance has changed more than once.

```bash
fly launch --no-deploy --copy-config
fly deploy
```

`auto_stop_machines = "stop"` scales to zero when idle, which keeps cost at zero
on a pay-as-you-go account at the price of a cold start.

The primary region is set to `yyz` (Toronto), near the plant this simulates.

The MQTT TCP listener on 1883 is only reachable if you also allocate a dedicated
IPv4 address, which Fly charges for. The flows use the broker in-process
regardless, and browsers can reach it over WebSocket at `/mqtt`.

---

## Docker, anywhere

```bash
docker build -t production-core .
docker run -d -p 1880:1880 -p 1883:1883 \
  -e PC_STORE=memory \
  -e PC_SEED_SHIFTS=3 \
  --name production-core production-core
```

Or with compose, which adds a named volume so plant history survives a restart:

```bash
docker compose up --build
```

The image is multi-stage: the runtime layer carries no build tooling and no dev
dependencies. It runs as the unprivileged `node` user, uses `tini` as PID 1 so
`SIGTERM` reaches Node and the shutdown handler gets to flush a final snapshot,
and declares a `HEALTHCHECK` against `/api/v1/ready`.

The build runs two checks and **fails** on either:

```dockerfile
RUN node tools/build-flows.js --check    # committed flows match their spec
RUN node scripts/warmup.js               # the flows actually load
```

A flow file Node-RED rejects would otherwise ship happily and only reveal itself
as an empty canvas on the deployed instance.

---

## Environment reference

Every setting has a working default. Full annotated list in
[`.env.example`](../.env.example).

### The ones that matter for a deployment

| Variable | Default | |
|---|---|---|
| `PORT` | `1880` | One port serves HMI, editor, API, Swagger and the docs. PaaS hosts inject this. |
| `PC_STORE` | `file` | **Set to `memory` on any ephemeral host.** |
| `PC_API_KEY` | `production-core-demo-key` | Required for writes. Change it on a public deployment. |
| `PC_EDITOR_READONLY` | `false` | **Set to `true` on a public deployment** so visitors can inspect flows but not redeploy them. |
| `PC_PUBLIC_URL` | — | Absolute base URL; makes the OpenAPI document list the real server. |
| `PC_SEED_SHIFTS` | `3` | Shifts backfilled with full detail. Each is ~375 vehicles and ~14 MB. |
| `PC_SIM_SPEED` | `1` | Real time. Higher values compress time; see the note below. |
| `PC_SERVERLESS` | auto | Set by detecting Vercel (`VERCEL=1`). Turns off Node-RED, MQTT and the file store, and makes requests advance the simulator. |
| `PC_FULL_RUNTIME_URL` | — | On serverless, `/red` and `/factory` redirect here — to a full deployment. |
| `PC_RATE_LIMIT_WRITES` | `120` | State-changing requests per minute per client IP; `0` turns the limit off. |
| `PC_SIM_AUTO_RELEASE_MINUTES` | `15` | On a public demo anyone can stop a station. The simulated supervisor restarts it after this long, so the line never stays starved. |
| `NODE_OPTIONS` | — | `--max-old-space-size=384` on a 512 MB instance. |

### A note on simulation speed

`PC_SIM_SPEED` defaults to **1** — real time — because the KPI engine measures
over **wall-clock** windows.

At speed 30 the plant completes a 60-second takt every 2 seconds but still
stamps wall-clock timestamps. A station then reports 30-second cycles against a
60-second ideal, throughput reads about twice the line's physical maximum, and
OEE pins at 100% behind the performance cap. The numbers stop meaning anything.

Real time keeps them consistent, and with 43 stations the plant is lively
enough to watch anyway — roughly one station event per second.

Raising it is still supported and useful for fast-forwarding. The dashboard sets
`timeCompression.active` and the HMI labels the connection badge
`live · 30× compressed`, so the inflated figures are never presented as real.

### Securing the flow editor

```bash
PC_EDITOR_USER=admin
PC_EDITOR_PASSWORD=<something long>
PC_EDITOR_READONLY=true
```

With both set, the editor requires a login to deploy; anyone not logged in still
gets read access, which is the point of a portfolio demo. The password is
bcrypt-hashed at boot rather than stored in plain text.

Setting only `PC_EDITOR_READONLY=true` makes the editor read-only for everyone,
with no login at all — usually what you want.

---

## Sizing

| | |
|---|---|
| Memory, idle after a 3-shift seed | ~160 MB RSS |
| Per seeded vehicle | ~36 KB |
| Cold boot (warm filesystem) | ~1.1 s |
| Cold boot (empty Node-RED user dir) | ~1.5 s |
| Seed time, 3 shifts (~1,000 vehicles) | ~2.5 s |

Recommended minimum: **512 MB**. It will run in 256 MB with
`PC_SEED_SHIFTS=1`, but there is little headroom once Node-RED is loaded.

---

## Post-deploy check

```bash
BASE=https://your-instance.example.com

curl -fsS $BASE/api/v1/ready
curl -fsS $BASE/api/v1/health | jq '{version, store: .store.collections, mqtt: .mqtt.running}'
curl -fsS $BASE/api/v1/kpi/dashboard | jq '.headline'
curl -fsS $BASE/factory/status | jq '.servedBy'     # proves the flows are running
curl -fsS $BASE/openapi.json > /dev/null
curl -fsS $BASE/docs/ARCHITECTURE.md | head -1   # the docs, as markdown to a tool
```

On Vercel, `/api/v1/health` also reports `"runtime": { "mode": "serverless" }`.

Or run the full 22-check suite against a local boot:

```bash
npm run smoke
```

---

## What this does not do

Being honest about the limits:

- **Single instance.** No horizontal scale — the store and the event bus are
  in-process. Scaling out means moving the store behind its existing repository
  interface into Postgres and the bus onto Redis or NATS.
- **No durable history on free tiers.** By design; see the top of this document.
- **No TLS of its own.** Every platform above terminates TLS upstream, and
  `trust proxy` is enabled so the app sees the real client protocol.
- **API-key auth only.** Adequate for a demo. Real deployment wants OIDC, mapped
  onto the operations already marked `security` in the OpenAPI document.
