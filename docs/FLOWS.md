# Node-RED flows

Open the editor at [`/red`](/red). Thirteen tabs, 204 nodes, seven custom nodes.

## Flows as code

`flows/flows.json` is a **build output**. Do not edit it by hand — it is
generated from [`flows/plant.spec.js`](../flows/plant.spec.js):

```bash
npm run build:flows     # regenerate
npm run verify:flows    # fail if the committed file has drifted (runs in CI)
```

### Why

Node-RED stores flows as a flat array of node objects with generated ids and
hand-placed coordinates. Edited by hand, that file is unreviewable: a one-node
change produces a diff full of moved coordinates, and adding a station to a
43-station plant means an afternoon of dragging.

The builder in [`tools/flow-builder.js`](../tools/flow-builder.js) emits that
array from a declarative description instead:

- **Ids are derived deterministically** from a logical name
  (`sha256(tab + '::' + name).slice(0, 16)`), so regenerating an unchanged spec
  produces a **byte-identical file**. A diff on `flows.json` shows only what
  actually changed.
- **Coordinates are assigned by a column/row grid**, so nodes never overlap and
  adding one does not shift the rest.
- **Wiring is by logical name**, so a typo is a build error — `Cannot wire 'a'
  to unknown node 'nope' on tab 'X'` — rather than a silently disconnected node
  discovered in production.

The generator also validates before writing: duplicate ids, orphaned tab
references, dangling wires, a `switch` whose output count disagrees with its
rule count, a `function` wired to more outputs than it declares, and any MQTT
node pointing at a broker config that does not exist.

The result is still a completely ordinary Node-RED file. It opens in the editor,
you can drag things around, and you can export it. Just run `build:flows` again
rather than committing the edit.

### Adding a station

Edit `src/core/plantModel.js`, then:

```bash
npm run build:flows && npm test
```

The flows, the REST API enums, the OpenAPI document, the simulator and the HMI
all pick it up, because all of them read the plant model rather than holding
their own copy.

---

## The tabs

### 00 — Plant Overview

Every domain event is mirrored onto MQTT by the application and arrives here.
This tab normalises the feed, routes it by severity, and re-publishes a compact
plant status heartbeat every 15 seconds.

Consumes `northstar/win/plant/event/#`, produces `northstar/win/plant/status`
(retained).

The heartbeat is deliberately trimmed from the full dashboard payload — a
heartbeat that ships 40 KB every 15 seconds is a heartbeat nobody subscribes to.

Also carries a `catch` node wired to the whole flow: a node that throws stops its
own branch, and catching centrally means one place to look.

### 10 — Body Shop

The generic line-monitoring shape: subscribe to the line's station events,
classify them, route state changes and cycle completions separately, and publish
a rolled-up line status every 10 seconds.

The status function sets the node's own status dot green/amber/red by OEE, so a
degrading line is visible in the editor without opening the debug sidebar.

### 20 — Paint Shop

Paint quality is dominated by booth conditions, so this tab watches humidity and
temperature on the telemetry feed and raises a `PROCESS` andon **before** the
defects start rather than reacting to them twenty minutes later.

```
humidity outside 58–70 %      →  PROCESS andon
temperature outside 22–25 °C  →  PROCESS andon
film build outside 95–135 µm  →  PROCESS andon
```

Alarms are rate-limited per station to one every two minutes: a booth drifts
slowly, and a repeated call is noise an operator learns to ignore.

Also runs the **paint inspection gate** at `PAINT-60` using the
`IP-PAINT-VISUAL` plan. A vehicle failing film build, colour delta-E or orange
peel is held here rather than carrying the defect into general assembly, where
the rework cost multiplies.

### 30 — Door Line

Tracks broadcast-built door sets. A door set carries the VIN it was removed
from, and the domain refuses to fit it to any other vehicle — so a mis-sequenced
door is a hard error rather than a warranty claim eighteen months later.

### 40 — Wheel & Tire

Watches the dynamic balancer over a **rolling 20-sample window**. One bad set is
noise; a falling mean across twenty is a worn spindle, and that is a maintenance
signal well before any individual set fails. Raises a `TOOLING` andon when the
mean pass rate drops below 95%.

### 50 — Sub-Assembly

Buffer starvation watch. Final assembly starves within two takts of a feeder
stopping, so the warning has to come from the **buffer level**, not from the line
stopping. Below two units of buffer, raises a `MATERIAL` andon against the
station that will starve.

Also counts quarantined sub-assemblies by class — a rising rate is an early
warning on an incoming supplier lot.

### 60 — Main Assembly

The production spine, and the tab with the most consequential logic.

**Torque verification.** `CHAS-10` (powertrain marriage), `CHAS-20` (suspension),
`FINAL-10` (wheels) and `FINAL-20` (seats) are the fastening operations that hold
the vehicle together. Every torque reading is checked against its specification
window from the plant model, and a reading outside it raises a `CRITICAL`
`TORQUE_LOW` / `TORQUE_HIGH` defect that the end-of-line gate will refuse to
release.

A torque reading with no vehicle at the station is **dropped**, not attributed —
raising it against the wrong VIN would be worse than losing it.

**Marriage verification.** Decking is the point of no return: once the powertrain
is bolted to the body, separating them is hours of work. So the check that the
right serialised powertrain is actually recorded in the right VIN's genealogy
happens immediately, at `CHAS-10`. A missing link is a stop-the-line condition —
the vehicle cannot be certified as built — and raises a `QUALITY` andon.

### 70 — Quality & EOL

The last decision in the plant. `EOL-60` runs the `IP-EOL-AUDIT` plan; pass
releases the vehicle to the yard and seals its genealogy, hold routes it to a
repair-bay queue held in flow context.

The release goes through the `pc-unit` **complete** operation, not a flag — so
the domain's precondition (no open defects) still applies, and a refusal shows
up on the node status rather than silently shipping a defective vehicle.

Also publishes a quality summary every 30 seconds: FPY, DPMO, sigma level, and
the defect Pareto by code and by station.

### 80 — Andon & Downtime

The andon board.

**Escalation sweep** every 30 seconds: any open call past its SLA moves up the
ladder — team leader → area supervisor (5 min) → plant manager (15 min).

**Live board** maintained in flow context from the andon event stream, published
retained to `northstar/win/plant/andon/board` so a subscriber gets current state
without replaying the log.

**Downtime tracking** accumulates minutes by reason code and surfaces the top
loss on the node status. Micro-stops never reach this tab — they are filtered at
the service layer.

### 85 — Maintenance

Station control over MQTT, and the preventive-maintenance board.

**PM board.** Every 60 seconds a `pc-station` node in `pmStatus` mode reads every
station's position against its PM interval; a function splits the result into
stations due or overdue and the rest, and publishes the board **retained** to
`northstar/win/plant/maintenance/due`. The node status shows how many stations
are due, so the tab tells you the answer without opening the debug sidebar.

**Command channel.** An `mqtt in` on `northstar/win/+/+/cmd` takes commands
from a line controller or a SCADA client:

```json
{ "command": "stop", "apiKey": "production-core-demo-key",
  "operator": "line-plc-7", "reasonCode": "SCHEDULED_BREAK" }
```

The validator checks the API key against `env.get("PC_API_KEY")`, the command
against the four legal ones and the station against the plant model — then a
`switch` routes it to one of four `pc-station` nodes (`start`, `stop`,
`maintenance`, `completeMaintenance`). Every path, including every refusal,
ends at the same acknowledgement builder, so the sender always gets a reply on
`…/cmd/ack`:

```json
{ "ok": true, "stationId": "BODY-20", "command": "stop",
  "state": "STOPPED", "mode": "STOPPED", "allowedActions": ["start", "maintenance"] }
```

A domain refusal (stopping a station that is already stopped) comes back as
`ok: false` with the same reason the HMI and the REST API give, because
`pc-station` reports it on `msg.error` instead of throwing.

**Maintenance log.** Subscribes to the maintenance events and keeps a running
count of orders, minutes and overruns in flow context — the numbers a
maintenance planner reviews each week.

### 90 — OEE & KPI Engine

One ISO 22400 calculation pass every 20 seconds, fanned out to per-line topics
so a subscriber can take just the line it cares about.

**Constraint alert.** A line is only as fast as its bottleneck, so the useful
alert is not "OEE is low" but "**the constraint has moved**" — that is the
station to go and look at. Published to `northstar/win/plant/constraint` when it
changes.

Shift trend published every five minutes.

### 95 — Factory API

HTTP endpoints served **by the flows themselves** under `/factory`, using the
classic `http in` → node → `http response` pattern.

| Endpoint | |
|---|---|
| `GET /factory/status` | Plant status as JSON |
| `GET /factory/board` | Line board as HTML, rendered by a `template` node |
| `GET /factory/line/:id` | One line's KPIs |
| `GET /factory/vehicle/:vin` | Full vehicle trace |
| `POST /factory/andon` | Raise an andon call |
| `POST /factory/recall` | Run a recall query |

These sit alongside the Express API at `/api/v1` and exist to demonstrate the
Node-RED pattern. Both call the same domain services, so they cannot disagree.

The recall response **caps the VIN list at 100** — a real recall can touch tens
of thousands, and the full list belongs in a file, not an HTTP response body.

### 99 — Traceability

Press the **Run recall drill** inject node. The flow picks the most
widely-used supplier lot, runs the recall query against the full build history,
and routes the result by containment:

```
                      ┌─▶ safety-critical AND shipped  →  SAFETY RECALL
  recall query  ──────┼─▶ containable in plant         →  CONTAIN
                      └─▶ nothing affected             →  no action
```

Also publishes a **vehicle passport** for every released vehicle: its as-built
record, sealed and immutable, with component count, safety-critical part count,
distinct lot count and material cost.

---

## Custom nodes

Seven nodes in `nodes/`, each a thin wrapper over a domain service. They appear
in the palette under **production core**.

| Node | Operations |
|---|---|
| `pc-unit` | get · move · advance · hold · rework · release · complete · scrap · history · wip · list |
| `pc-station` | get · setState · cycle · telemetry · list · control · start · stop · maintenance · completeMaintenance · pmStatus |
| `pc-workorder` | list · get · create · release · transition |
| `pc-quality-gate` | evaluate · inspect — **two outputs: pass / hold** |
| `pc-genealogy` | get · trace · recall · lotUsage · lots |
| `pc-oee` | station · line · plant · dashboard · trend |
| `pc-andon` | raise · acknowledge · escalate · resolve · sweep · list |

### Domain errors are a branch, not a crash

By default a domain refusal does **not** throw into the flow. A quality gate
refusing a vehicle is a normal outcome a flow should branch on, so the message
still arrives, annotated:

```js
msg.payload = null;
msg.error = { code: 'QUALITY_HOLD', message: '…', status: 409, details: { … } };
```

Wire a `switch` on `msg.error.code` to handle it. Tick **Throw domain errors** on
the node to get Node-RED `catch`-node behaviour instead.

`pc-quality-gate` is the exception: its decision *is* the product, so it is
modelled as two outputs rather than an error.

### Node status tells you what happened

Every node sets its status dot from the result — `-> CHAS-10`, `OEE 71.2%`,
`pass BODY-50`, `hold: CRITICAL`, `527 affected`, `escalated 2`. The plant's
state is legible from the canvas without opening the debug sidebar.

### Domain access from a `function` node

The plant model and the whole service context are exposed to function nodes
through global context, so a flow can answer a domain question directly instead
of making an HTTP call back into its own process:

```js
const core  = global.get('productionCore');
const plant = global.get('plantModel');

const station = plant.getStation('CHAS-10');
const spec    = station.torqueSpecs[0];
const buffers = core.production.bufferLevels();
```

Used by the torque verification and buffer-starvation flows.

---

## MQTT topics

```
northstar/<site>/<line>/<station>/telemetry     sensor samples
northstar/<site>/<line>/<station>/state         station state changes
northstar/<site>/<line>/<station>/event         everything else at that station
northstar/<site>/<line>/<station>/cmd           inbound: start / stop / maintenance
northstar/<site>/<line>/<station>/cmd/ack       reply to a command, ACK or NACK
northstar/<site>/<line>/status                  rolled-up line status  (retained)
northstar/<site>/<line>/kpi                     per-line ISO 22400 KPIs (retained)

northstar/<site>/plant/event/<event/type>       every event, keyed by type
northstar/<site>/plant/status                   plant heartbeat        (retained)
northstar/<site>/plant/kpi                      plant KPIs             (retained)
northstar/<site>/plant/quality                  quality summary        (retained)
northstar/<site>/plant/andon/board              live andon board       (retained)
northstar/<site>/plant/andon/escalated          escalations
northstar/<site>/plant/maintenance/due          PM board               (retained)
northstar/<site>/plant/constraint               constraint shifts
northstar/<site>/plant/trend                    shift trend            (retained)
northstar/<site>/plant/released                 vehicle released
northstar/<site>/plant/recall                   recall results
northstar/<site>/plant/passport/<vin>           as-built record
```

`<site>` is `PC_SITE_ID` lowercased — `win` by default.

Subscribe with any MQTT client:

```bash
mosquitto_sub -h localhost -p 1883 -t 'northstar/#' -v
```

Or from a browser over WebSocket at `ws://localhost:1880/mqtt`.

The broker config in the flows references `${PC_MQTT_HOST}` and
`${PC_MQTT_PORT}`; the runtime writes the **resolved** values (including
defaults) into the environment before Node-RED reads the flow file. Hardcoding
the port meant a deployment on any other port came up with every MQTT node
silently disconnected — a bug the smoke test caught.

---

## Editing flows in the editor

You can. The editor is fully functional and Deploy works.

But `flows/flows.json` is regenerated from its spec, so an editor change is
overwritten by the next `npm run build:flows`, and CI fails on the drift. For a
permanent change, edit `flows/plant.spec.js` and rebuild.

Set `PC_EDITOR_READONLY=true` to serve the editor read-only, which is what the
deployment configs do: a visitor can inspect the flows but not redeploy them.
