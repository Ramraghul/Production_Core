# Architecture

## The decision everything else follows from

> The manufacturing domain is a plain, testable Node library. Node-RED is the
> orchestration layer on top of it.

Node-RED is excellent at what it is for — wiring events to actions, visually,
in a way a controls engineer can read and change. It is a poor place to put
business rules. A `function` node containing the quality-gate logic cannot be
unit tested, cannot be reviewed in a diff, and exists in exactly one place in
one flow.

So the rules live in `src/core/` as pure functions over immutable documents, and
the flows call into them through seven custom nodes. The REST API calls the same
services. Neither can drift from the other, because there is only one
implementation.

The alternative — flows as the system of record, with `flow.set()` holding state
— is what most Node-RED MES demos do. It works until you need to answer "which
vehicles contain this lot", at which point there is nowhere to ask.

## Layers

<!-- live:architecture -->
```
┌──────────────────────────────────────────────────────────────┐
│  Interface                                                   │
│                                                              │
│  Express        Node-RED flows    Simulator       Docs site  │
│  src/api/       flows/ + nodes/   src/simulator/  src/docs/  │
└───────────────────────────┬──────────────────────────────────┘
                            │  all of them call the same services
┌───────────────────────────▼──────────────────────────────────┐
│  Services — transaction boundary                             │
│  src/services/                                               │
│                                                              │
│  production   quality   operations   kpi   trace             │
│                                                              │
│  Decides *when* to apply a rule, persists the result,        │
│  publishes the event. Anything spanning two entities         │
│  lives here.                                                 │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  Domain core — pure functions, no I/O                        │
│  src/core/                                                   │
│                                                              │
│  plantModel  unit  workOrder  subAssembly  genealogy         │
│  bom  quality  andon  downtime  stationControl  oee  shift   │
│  stateMachines  ids  errors                                  │
│                                                              │
│  Every function takes a document and returns a NEW one.      │
│  Nothing here knows what a database or an HTTP request is.   │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  Infrastructure                                              │
│  src/store/  (repository, seeder)                            │
│  src/services/eventBus.js                                    │
│  src/broker/ (embedded MQTT)                                 │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point downward only. `src/core/` imports nothing from
`src/services/`, `src/api/` or `src/store/` — which is exactly why it can be
tested as pure functions with no fixtures, no database and no mocks.

## Why immutable documents

Every core function returns a new object rather than mutating its input:

```js
const moved = unitCore.moveToStation(unit, 'CHAS-10', { at: now });
// `unit` is untouched; the caller decides whether to persist `moved`
```

Three things fall out of this:

1. **Testing is trivial.** No setup, no teardown, no shared state between cases.
2. **A rejected operation leaves nothing half-applied.** If `moveToStation`
   throws a routing violation, there is no partially-mutated unit to clean up.
3. **The service layer becomes the obvious transaction boundary.** It is the
   only place that decides to write.

The cost is allocation churn. At plant scale — 43 stations, a few hundred
vehicles in the hot window — that is irrelevant, and it would be the wrong
trade at a million units an hour.

## The event bus

Everything that happens is published exactly once to an in-process event bus,
and four consumers fan out from it:

<!-- live:eventbus -->
```
                    ┌──▶ Repository        (append to the event log)
                    │
  Service ──▶ Bus ──┼──▶ MQTT broker       (republish for the flows)
                    │
                    ├──▶ SSE endpoint      (stream to the browser HMI)
                    │
                    └──▶ KPI engine        (fold into shift counters)
```

Publishing is synchronous and **never throws**. A subscriber that fails is
logged and skipped, because a broken dashboard must not be able to stall a
production line. That is enforced in `EventBus.#safeEmit` and covered by a test
that registers a throwing subscriber and asserts the bus survives.

## The store, and why it is not a database

`src/store/repository.js` is an in-memory store with an optional JSON snapshot
on disk. That looks like a shortcut. It is a constraint working backwards from
the deployment target:

1. **Free hosting tiers give you an ephemeral disk and no managed database.** A
   native module that fails to compile on a cold start takes the whole demo
   down, and `better-sqlite3` is exactly that risk.
2. **A plant's hot data set is small.** One shift of vehicles, events and
   telemetry fits comfortably in RAM — measured at **36 KB per vehicle**, so a
   full 480-vehicle shift is about 17 MB.
3. **This is how a real MES edge tier works anyway.** It caches current state in
   memory and flushes to a historian; it does not round-trip to Postgres for
   every station scan.

The store is deliberately narrow — `put`, `get`, `find`, `count`, `append`,
`nextSequence`, plus the two secondary indexes — so swapping in Postgres or
TimescaleDB is one adapter, not a rewrite.

### Bounded memory

Time-series collections are **capped ring buffers**:

| Collection | Cap | Why |
|---|---|---|
| `events` | 20,000 | The plant event log |
| `telemetry` | 10,000 | Sensor samples |

Without the cap, a long-running instance grows without bound and is eventually
OOM-killed. With it, memory is flat no matter how long it runs — which matters
on a 512 MB free instance.

### Hot and cold tiers

The seeder splits history the way a real MES splits it:

- **Hot** — the last `PC_SEED_SHIFTS` shifts with full per-vehicle detail:
  genealogy, station history, defects, inspections. This is what the
  traceability and OEE screens read.
- **Cold** — everything older, as one aggregate row per shift in
  `shiftMetrics`.

The trend chart reads whichever tier holds a given shift, marks aggregate bars
with a hatch pattern so they are never mistaken for recomputed figures, and
truncates the current shift at `now` so a two-hour-old shift is not reported as
though it had run eight.

## The secondary indexes

Two indexes are maintained as data is written:

```js
lotToVins  : Map<lotCode, Set<vin>>   // recall: which vehicles have this lot
serialToVin: Map<serial, vin>         // which vehicle got this sub-assembly
```

The recall query is the reason. Scanning every genealogy tree for a lot code is
O(vehicles × components); the index makes it O(1) plus the size of the result.
Measured on the running demo: **527 affected vehicles in 256 ms**, against a
build history of a thousand.

Part-number queries deliberately do *not* use an index — a part number appears
in nearly every vehicle, so an index would not narrow anything.

## Embedded MQTT

The broker (Aedes) runs **in-process**. This is the single decision that makes
the project deployable anywhere: no Mosquitto to install, no second container,
no managed broker to pay for. Node-RED's MQTT nodes connect to `127.0.0.1:1883`
and behave exactly as they would against a real broker.

Two listeners:

- **TCP** on `PC_MQTT_PORT` — for Node-RED and any local MQTT client
- **WebSocket** on the HTTP port at `/mqtt` — so a browser, or a PaaS host that
  exposes only one TCP port, can still reach it

The topic tree is ISA-95 shaped, one level per hierarchy tier:

```
northstar/<site>/<line>/<station>/telemetry
northstar/<site>/<line>/<station>/state
northstar/<site>/<line>/<station>/event
northstar/<site>/<line>/<station>/cmd       ← inbound: start / stop / maintenance
northstar/<site>/<line>/<station>/cmd/ack   ← the reply, ACK or NACK with a reason
northstar/<site>/plant/event/<event/type>
northstar/<site>/plant/maintenance/due      ← retained PM board
```

The `cmd` topic is the only inbound one. It carries the API key in the payload
and is validated in the flow before anything reaches a service, so a client on
the broker that knows the topic tree still cannot stop a station without the key.

A busy port is **not fatal**. The broker logs a warning and the application
continues — the REST API, the HMI and the flows all work without it.

### A bug this surfaced

The broker config in the flows originally hardcoded port 1883. The smoke test
caught it: running the app on `PC_MQTT_PORT=18883` left every MQTT node
connected to a *different* instance, flapping every five seconds. The flows now
reference `${PC_MQTT_HOST}` and `${PC_MQTT_PORT}`, and the runtime writes the
**resolved** config (including defaults) into `process.env` before Node-RED
reads the flow file — otherwise the substitution resolves to an empty string.

## Node-RED embedding

Node-RED runs inside the Express process rather than as a separate service:

```js
RED.init(httpServer, settings);
app.use('/red', RED.httpAdmin);       // editor
app.use('/factory', RED.httpNode);    // http-in nodes
await RED.start();
```

This buys three things:

1. **One port**, so the flows, API, HMI and Swagger all deploy to a free tier
   that exposes a single TCP port.
2. **The custom nodes call the services directly** — no HTTP hop, no second copy
   of the state.
3. **One lifecycle** — the flows come up and go down with the application.

### Mount order matters

Express matches middleware in registration order and searches *forward* for an
error handler. So `createApp()` mounts the API, and `finalizeApp()` mounts the
static assets and the terminal error handler — with Node-RED mounted in
between. An error handler registered before Node-RED would never see its errors.

### The context handshake

Node-RED loads custom nodes through its own module loader, so they cannot be
handed the service context by constructor injection. `src/context.js` is a
deliberate, documented singleton: the composition root registers the context at
boot, and each node reads it on first message. Its getter throws a specific,
actionable error rather than returning `undefined`, because a node silently
getting no context looks like a flow wiring bug and sends the operator hunting
in the wrong place.

## Station control: two dimensions, not one

A station has a **process state** (RUNNING, IDLE, STARVED, BLOCKED, DOWN...)
that the plant drives, and a **control mode** (AUTO, STOPPED, MAINTENANCE) that
people drive. They are kept separate on purpose. Folding them into one enum is
the obvious design and it is wrong: a station an operator stopped is not the
same as a station that starved, and the simulator must be able to tell them
apart without a list of special cases.

Any mode other than AUTO is a **lockout**, enforced in the service layer rather
than in each caller:

- `operations.setStationState` refuses automated changes to a locked station
  unless the caller passes `override`, and says who locked it and why;
- `production.moveUnit` refuses to route a vehicle *into* a locked station;
- the simulator's fault injection, reconciliation and andon handling skip locked
  stations, so a technician's station cannot be "repaired" by a random draw.

Every caller — REST, the Node-RED nodes, the MQTT command channel, the HMI —
goes through the same four service calls, and the allowed actions for any
moment come from one function, `stationControl.availableActions`, which the UI
renders buttons from. The UI therefore never offers a button the service would
refuse. See [Station control](STATION-CONTROL.md) for the model itself.

## The documentation site

These pages are the markdown files in `docs/`, rendered on the server by
`src/docs/` (markdown-it and highlight.js — no build step, no static-site
generator). Two details are worth knowing:

- **Content negotiation.** `/docs/ARCHITECTURE.md` returns this page to a
  browser and the raw markdown to `curl`, so the same URL serves a reader and a
  tool.
- **Diagrams degrade.** A `<!-- live:NAME -->` comment on the line directly above
  an ASCII diagram turns it into a live widget that reads this instance's API.
  The ASCII is kept under "Text version", so the markdown still reads correctly
  on GitHub, in an editor, and with JavaScript off.

The state-machine diagrams are drawn from `GET /api/v1/reference/state-machines`,
which is built from the same transition tables the domain enforces — a diagram
cannot show a transition the code would refuse.

## Performance notes

A request path that does real work on every HMI poll will eventually show up
as simulator lag, because they share an event loop. Three measures keep the
tick under a few milliseconds:

- **The dashboard is cached for two seconds**, and the trend for thirty. Every
  open HMI polls; the plant does not change meaningfully faster than that.
- **KPIs index each window once.** Station visits and builds are grouped by
  station and line for a window keyed on the store's write counter, instead of
  every station scanning every visit.
- **`require()` is hoisted.** An inline `require` in a hot path costs a
  package.json lookup per call; on a slow filesystem (an NTFS mount, a network
  drive) that alone took the simulator tick from 3 ms to over a second.

## Boot order

Order matters in three places, all load-bearing:

<!-- live:boot -->
```
1. Store + event bus + services      createContext()
2. MQTT broker                       ← before Node-RED, or the flows' mqtt-in
                                       nodes come up disconnected and back off
3. Express app (API, Swagger)
4. Node-RED init                     ← registers the context BEFORE loading any
                                       node module
5. finalizeApp()                     ← static + error handler, after Node-RED
                                       has claimed /red and /factory
6. HTTP listen
7. Node-RED start                    (flows begin running)
8. Simulator
```

Shutdown reverses it, so nothing publishes into a closed broker, and a final
snapshot is flushed before exit.

## Two composition roots

The layering is what makes a second deployment shape cheap.
[`src/server.js`](../src/server.js) boots everything above, in the order above.
[`src/serverless.js`](../src/serverless.js) builds the same context and the
same Express app for a Vercel function, and simply leaves out the two things a
function cannot host: Node-RED and the MQTT broker. Nothing in the services or
the core changes, because neither ever knew which transport was on top.

Two things do change, both at the edges:

- **The simulator is advanced by requests.** A frozen instance's timer does not
  fire, so each API request first replays the ticks it missed, up to a limit —
  `Simulator#catchUp`. A longer gap is skipped: replaying it would stamp minutes
  of output onto one instant.
- **The live stream ends itself** before the platform's time limit, with a
  `retry:` hint, so the browser reconnects instead of seeing an error.

## Trade-offs that went the other way

**Node-RED 4.1 LTS, not 5.** Node-RED 5 requires Node ≥ 22.9, which rules out
several free hosting runtimes. 4.1 requires Node ≥ 18.5 and deploys everywhere.

**No Dashboard 2.0.** The plant HMI is hand-written vanilla JS. Adding
`@flowfuse/node-red-dashboard` would mean a large dependency whose version
churn is outside this project's control, on a page whose job is to stay up on a
wall for eight hours. The custom HMI has no build step and nothing to keep
patched.

**Express 4, not 5.** Express 5's `path-to-regexp` v8 changed wildcard syntax.
Express 4 is well-understood and Node-RED embeds its own copy regardless.

**SSE, not WebSocket, for the live feed.** The plant feed is one-directional.
SSE is plain HTTP, so it survives every PaaS proxy and needs no extra port.

**The flow-served `/factory` API duplicates part of `/api/v1`.** Deliberately.
It demonstrates the Node-RED `http-in` pattern, and because both call the same
services they cannot disagree. The duplication is the point being made.

## Where it would go next

The honest limits, and what each would take:

| Limit | What it needs |
|---|---|
| Single process — no horizontal scale | Extract the store behind the existing repository interface into Postgres; the event bus becomes Redis pub/sub or NATS |
| Time-series data is capped in RAM | Flush telemetry to TimescaleDB or InfluxDB on the existing event-bus subscription |
| Simulated equipment | Replace the simulator with OPC-UA and Sparkplug-B clients; the flows and services do not change |
| API key auth only | OIDC, with roles mapped onto the operations already marked `security` in the OpenAPI document |
| One site | The plant model is already hierarchical; multi-site needs a site dimension on the store keys |

The point of the repository interface and the event bus is that each of those is
an adapter swap rather than a rewrite.
