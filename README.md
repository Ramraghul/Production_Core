# Production Core

**An end-to-end Manufacturing Execution System for a vehicle assembly plant, built on Node-RED.**

Seven production lines and 43 stations — body shop, paint, door line, wheel &
tire, sub-assembly, main assembly and end-of-line quality — with the domain
rules a real plant runs on: enforced routing, quality gates that actually stop
vehicles, full as-built genealogy, and supplier-lot recall analysis.
Operators can stop and start any station and technicians can lock one out for
maintenance under a work order, with the lockout enforced everywhere.

<!-- live:plant -->
```
                         ┌─────────────┐
      ┌──── DOOR ───────▶│             │
      │                  │             │
      ├──── TIRE ───────▶│    MAIN     │
      │                  │  ASSEMBLY   │──▶ QUALITY ──▶ released
      ├──── SUB-ASM ────▶│             │      (EOL)
      │                  │             │
 BODY ──▶ PAINT ────────▶│             │
                         └─────────────┘
```

---

## Live demo

**<https://production-factory-core.vercel.app>** — nothing to install.

| | |
|---|---|
| **Plant HMI** | <https://production-factory-core.vercel.app> |
| **Swagger UI** | <https://production-factory-core.vercel.app/api-docs> |
| **REST API** | <https://production-factory-core.vercel.app/api/v1> |
| **OpenAPI document** | <https://production-factory-core.vercel.app/openapi.json> |
| **Documentation** | <https://production-factory-core.vercel.app/docs> |
| **Health check** | <https://production-factory-core.vercel.app/api/v1/health> |
| **Live event stream (SSE)** | <https://production-factory-core.vercel.app/api/v1/events/stream> |

Reads are open. Writes need the demo key `production-core-demo-key` — the
plant screen's Start, Stop and Maintenance buttons already send it, and in
Swagger it goes under **Authorize**.

The live demo runs on Vercel, which hosts functions rather than a long-running
server. So the two parts that need one — the **Node-RED flows** and the
**MQTT broker** — are not in it; run it locally to see those. Its plant is
reseeded, identically, whenever Vercel starts a fresh instance.

<!-- live:stats -->

---

## Run it locally

```bash
npm install
npm start
```

That is the whole setup — no database to provision, no MQTT broker to install,
no seed script to run first. The plant boots with three shifts of production
history already in it and starts building vehicles immediately. Everything is
served on one port:

| | |
|---|---|
| **Plant HMI** | <http://localhost:1880> — station start / stop / maintenance |
| **Node-RED flows** | <http://localhost:1880/red> — 13 tabs, 204 nodes, 7 custom nodes |
| **Swagger UI** | <http://localhost:1880/api-docs> — 76 paths, 83 operations |
| **REST API** | <http://localhost:1880/api/v1> |
| **Documentation** | <http://localhost:1880/docs> — with live diagrams of the running plant |
| **Line board (served by the flows)** | <http://localhost:1880/factory/board> |
| **Live event stream (SSE)** | <http://localhost:1880/api/v1/events/stream> |
| **MQTT broker** | `mqtt://localhost:1883`, or WebSocket at `ws://localhost:1880/mqtt` |

With Docker, the same addresses:

```bash
docker compose up --build
```

To preview exactly what the Vercel deployment serves, without an account:

```bash
npm run start:serverless
```

It serves on <http://localhost:3000>.

---

## Why this is not a toy

Most MES demos are a dashboard over a table of random numbers. The difference
here is that the rules are real and they *refuse* things:

- **Routing is enforced.** A vehicle cannot skip a station. `POST
  /units/{vin}/move` to the wrong station returns `409 INVALID_STATE_TRANSITION`
  with the station it should have gone to.
- **Quality gates stop vehicles.** A unit carrying an open `CRITICAL` defect
  does not move past a gate and cannot be released, no matter which interface
  asks — REST, a Node-RED flow, or the simulator.
- **Genealogy is evidence.** Every part is recorded with its supplier lot at the
  point of use. The record is append-only and is *sealed* when the vehicle is
  released; writing to a sealed record throws.
- **A serialised sub-assembly is consumed exactly once, ever.** A powertrain
  cannot appear in two vehicles' service records.
- **Door sets are broadcast-built.** They carry the VIN they were removed from
  and the domain refuses to fit them to any other vehicle.
- **VINs are real.** ISO 3779 / FMVSS 565 structure with a correct position-9
  check digit — they validate in any off-the-shelf VIN decoder. The test suite
  checks the algorithm against the canonical NHTSA test VIN, not just against
  itself.

Those rules were not added for show. Writing the demo-data seeder, the domain
layer rejected it four separate times — a quarantined powertrain being fitted,
a vehicle released with an open defect, a `CRITICAL` defect waived
`USE_AS_IS`, a door set going to the wrong VIN. Each time the seeder was wrong
and the domain was right.

---

## The query this exists to answer

A supplier reports a bad batch. The question is not *"did we use it"* — it is
**which vehicles have it, and can we still stop them.**

```bash
curl -s localhost:1880/api/v1/trace/lots | jq '.items[0].lotCode'

curl -s -X POST localhost:1880/api/v1/trace/recall \
  -H 'content-type: application/json' \
  -H 'x-api-key: production-core-demo-key' \
  -d '{"lotCode":"BREMBO-PN-BRAKE-FRONT-2638B","reason":"supplier alert"}' | jq
```

```json
{
  "affectedCount": 527,
  "byContainment": { "IN_PLANT": 3, "FINISHED_GOODS": 519, "SHIPPED": 0, "SCRAPPED": 5 },
  "supplier": "BREMBO",
  "safetyCritical": true,
  "containableNow": 522,
  "estimatedRecallCostCad": 260742,
  "recommendation": {
    "action": "CONTAIN_IN_PLANT",
    "rationale": "All 527 affected vehicle(s) are still under plant control; hold and rework before release"
  }
}
```

527 vehicles, traced through two sub-assembly stations, in **256 ms** — because
lot codes are indexed as they are consumed rather than scanned for afterwards.
The `IN_PLANT` figure is the one that matters: it is the number that can still
be stopped before they ship, which is the only cheap outcome once a bad lot is
confirmed.

The **Traceability** tab in the HMI runs exactly this query with a picker.

---

## Architecture

The shape of it is one decision, made deliberately:

> **The manufacturing domain is a plain, testable Node library. Node-RED is the
> orchestration layer on top of it. Both the flows and the REST API call the
> same services, so they cannot disagree about what the plant is doing.**

<!-- live:architecture -->
```
                    ┌──────────────────────────────────────┐
  Browser ─────────▶│  Express                             │
                    │   /            plant HMI             │
                    │   /api/v1      REST API              │
                    │   /api-docs    Swagger UI            │
                    │   /red         Node-RED editor       │
                    │   /factory     flow-served endpoints │
                    │   /docs        this documentation    │
                    └───────────────┬──────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────┐
                    │  Services                            │
  Node-RED ────────▶│   production · quality · operations  │◀──── Simulator
  (7 custom nodes)  │   kpi · trace                        │
                    └───────────────┬──────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────┐
                    │  Domain core (pure functions)        │
                    │   plantModel · unit · workOrder      │
                    │   subAssembly · genealogy · bom      │
                    │   quality · andon · downtime · oee   │
                    │   stationControl · stateMachines     │
                    └───────────────┬──────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────┐
                    │  Repository  +  in-process event bus │
                    └───────────────┬──────────────────────┘
                                    │
                            Embedded MQTT broker (Aedes)
```

Every layer is one-directional: the core knows nothing about HTTP, the services
know nothing about Node-RED, and the flows know nothing about the store. That
is what makes the core testable as pure functions and the flows swappable.

Full reasoning, including the trade-offs that went the other way, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Flows as code

`flows/flows.json` is **generated**, not hand-edited. It is built from a
declarative spec in [`flows/plant.spec.js`](flows/plant.spec.js):

```bash
npm run build:flows     # regenerate
npm run verify:flows    # fail if the committed file has drifted (runs in CI)
```

Node ids are derived deterministically from logical names, so regenerating an
unchanged spec produces a **byte-identical file** — a diff on `flows.json` shows
only what actually changed, instead of a wall of moved coordinates. Wiring is by
name, so a typo is a build error rather than a silently disconnected node
discovered in production.

---

## What is in the box

| | |
|---|---|
| Production lines | 7 (body, paint, door, wheel & tire, sub-assembly, main assembly, quality) |
| Stations | 43 |
| Vehicle models | 3 (BEV sedan, hybrid SUV, pickup) |
| Part master | 49 parts, 20 suppliers, lot- and safety-flagged |
| Defect catalogue | 30 codes across 6 families |
| Inspection plans | 11, with real spec windows |
| Downtime reasons | 19, mapped to the Six Big Losses |
| Andon call types | 6, each with a response SLA |
| Serialised sub-assembly classes | 7 |
| Station control | Operator start / stop, 3 maintenance types, PM checklists by capability |
| Node-RED | 13 tabs, 204 nodes, 7 custom nodes |
| REST API | 76 paths, 83 operations, OpenAPI 3.0 |
| Tests | 392 across unit, API, docs, Node-RED node and contract suites |
| Code | ~26,000 lines |

### Standards it follows

- **ISA-95 / IEC 62264** — Enterprise → Site → Area → Work Centre → Work Unit
- **ISO 22400-2** — OEE, TEEP, MTBF, MTTR, FPY and the loss waterfall
- **ISO 3779 / FMVSS 565** — VIN structure and check digit
- **Six Big Losses** — downtime classification

---

## Operational detail worth a look

A few places where the implementation is more careful than it needed to be:

**Performance is capped at 100%, and says why.** A station reporting more output
than its ideal cycle time allows means the master data is wrong, not that the
station is superhuman. Letting it exceed 100% silently inflates plant OEE and
hides a bad cycle time. The value is capped and a `PERFORMANCE_CAPPED` warning
is attached to the result.

**A line is not the average of its stations.** A line can only run as fast as its
constraint, so availability and performance come from the bottleneck station,
while quality *compounds* along the route — a defect at any station spoils the
unit. Forty stations at 99% each is 67% rolled throughput yield, not 99%.

**Micro-stops are not downtime.** A station blocked for four seconds while the
one downstream finishes is a minor stoppage. Logging it as a breakdown buries
the real failures, so stops under the threshold are discarded — they still
depress the *performance* factor, which is where ISO 22400 puts idling and minor
stops. Doing this cut recorded downtime events by 4× without losing a single
real stoppage.

**Stopping a station is a lockout, not a pause.** A station has a process state
the plant drives and a control mode people drive, kept separate on purpose. Any
mode but `AUTO` locks the station: the simulator, the flows and a line
controller are all refused, and vehicles back up behind it the way they would
on a real line. The HMI draws its buttons from the same function the API
enforces, so it never offers an action the server would refuse — and a refused
action says why. See [Station control](docs/STATION-CONTROL.md).

**Skipping maintenance is not free.** Every station has a PM interval derived
from its MTBF. Past it, the station's failure hazard rises to 3× — so a plant
that ignores the PM board sees more breakdowns, and the OEE shows it.

**Andon and downtime cannot disagree.** Raising a line-stopping call also puts
the station `DOWN` and opens a linked downtime record; resolving it reverses
both. Plants that make those separate manual steps end up with two logs that
contradict each other, and then nobody trusts either.

**The demo is never empty.** Free-tier containers cold-start at arbitrary
moments, and a naive seeder produces nothing if the current shift began two
minutes ago. The seeder backfills detail for recent shifts, keeps reaching
further back until it has produced something, and lets work in progress carry
across shift boundaries the way a real line does. Verified across all 96
half-hourly boot moments in a day: every one produces a populated plant.

**Simulated time is real time by default.** The KPI engine measures over
wall-clock windows, so compressing the simulation makes a station appear to
cycle faster than its ideal and pushes throughput past the line's physical
maximum. `PC_SIM_SPEED` therefore defaults to 1; raising it still works, and the
dashboard labels the resulting figures as compressed rather than presenting them
as real.

**The KPI window widens early in a shift.** A shift that started two minutes ago
has produced nothing, and reporting "OEE 0%" for it is correct and useless. Below
20 minutes elapsed the dashboard reports a rolling 8-hour window and labels it
as such.

---

## Deploy it free

The application is a single container with no external dependencies — no
database, no message broker, no sidecar — which is what makes a genuinely free
deployment possible.

| Platform | Free? | Notes |
|---|---|---|
| **Render** | Free indefinitely | Spins down after 15 min idle; ~50 s cold start. [`render.yaml`](render.yaml) is a one-click blueprint. |
| **Hugging Face Spaces** | Free indefinitely | No spin-down on request; paused after 48 h with no traffic. [`deploy/huggingface/`](deploy/huggingface/) |
| **Koyeb** | Free instance | One service on the free plan. |
| **Fly.io** | Check current pricing | [`fly.toml`](fly.toml) included. Their free allowance has changed more than once. |
| **Vercel** | Free (Hobby) | **Live at <https://production-factory-core.vercel.app>**. Serverless: HMI, API, Swagger and docs — **without Node-RED and MQTT**, which need a long-running process. [`vercel.json`](vercel.json) |

Render, Hugging Face, Koyeb and Fly run the whole application. Vercel runs the
parts that fit in a function; set `PC_FULL_RUNTIME_URL` to a full deployment and
its `/red` and `/factory` links go there instead.

Because free tiers give you an **ephemeral disk**, `PC_STORE` is set to `memory`
in every deployment config and the plant is reseeded deterministically on each
boot. That is a deliberate design constraint, not a limitation worked around —
and it is why the seeder had to be made robust.

Step-by-step instructions for each: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Development

```bash
npm start              # run everything
npm run dev            # with --watch

npm test               # 392 tests
npm run test:coverage  # with coverage thresholds
npm run smoke          # boot the full stack and drive it over HTTP and MQTT
npm run lint

npm run build:flows    # regenerate flows/flows.json from its spec
npm run verify:flows   # assert the committed file is in step
```

### Test layers

| Suite | What it covers |
|---|---|
| `test/unit` | Domain core as pure functions, plus store, seeder and simulator |
| `test/api` | The REST API and the docs site through real HTTP via supertest |
| `test/nodes` | The custom nodes inside a real Node-RED runtime |
| `test/contract` | **Drift detection** — every served route must be documented and vice versa; `flows.json` must match its spec byte for byte |
| `npm run smoke` | Boots the real process — MQTT broker, Node-RED, simulator — and exercises 22 checks end to end |

More on the testing approach, and what each layer is deliberately *not*
testing: [docs/TESTING.md](docs/TESTING.md).

---

## Configuration

Every setting has a working default; `.env` is optional. See
[`.env.example`](.env.example) for the annotated list. The ones worth knowing:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `1880` | One port serves HMI, editor, API and docs |
| `PC_STORE` | `file` | `memory` for ephemeral hosts, `file` for local durability |
| `PC_API_KEY` | `production-core-demo-key` | Required for writes; reads stay open |
| `PC_SIM_SPEED` | `1` | Real time. Higher compresses time, which inflates throughput against wall-clock KPI windows — the dashboard flags it |
| `PC_SEED_SHIFTS` | `3` | Shifts backfilled with full per-vehicle detail |
| `PC_RATE_LIMIT_WRITES` | `120` | Writes per minute per client IP, since the demo key is public; `0` = off |
| `PC_SIM_AUTO_RELEASE_MINUTES` | `15` | The simulated supervisor restarts a forgotten operator stop, and the crew signs off maintenance on plan. `0` disables both |
| `PC_EDITOR_READONLY` | `false` | Serve the flow editor read-only for a public demo |

---

## Documentation

The documentation is published at <https://production-factory-core.vercel.app/docs>
(and served at <http://localhost:1880/docs> when you run it locally), rendered
with live diagrams of the running plant, state machines drawn from the rules
the code enforces, an OEE calculator backed by the real engine, runnable API
examples, a source browser and search (<kbd>/</kbd>). Its examples use the
address you are reading them on. The same files read fine as plain markdown
here.

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, the decisions and their trade-offs |
| [DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md) | Entities, state machines, the plant model |
| [STATION-CONTROL.md](docs/STATION-CONTROL.md) | Operator start / stop, lockout, maintenance orders, PM scheduling |
| [API.md](docs/API.md) | REST API guide with worked examples |
| [FLOWS.md](docs/FLOWS.md) | The 13 flow tabs and the 7 custom nodes |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Free-tier deployment, platform by platform |
| [TESTING.md](docs/TESTING.md) | Test strategy and what each layer proves |
| [RUNBOOK.md](docs/RUNBOOK.md) | Operating it: health, failure modes, recovery |

---

## Licence

MIT. The plant, its suppliers and its vehicles are fictional; the process flow,
station names, takt times, defect taxonomy and KPI definitions mirror how a
North American vehicle assembly plant actually works.
