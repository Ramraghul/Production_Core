# REST API

Base URL `/api/v1`. Interactive documentation with a working **Try it out** at
[`/api-docs`](/api-docs); the raw OpenAPI 3.0 document is at
[`/openapi.json`](/openapi.json).

76 paths, 83 operations.

## Authentication

Reads are open, so the hosted demo is browsable without credentials. Anything
that changes plant state needs an API key:

```bash
curl -X POST localhost:1880/api/v1/work-orders \
  -H 'x-api-key: production-core-demo-key' \
  -H 'content-type: application/json' \
  -d '{"modelCode":"NS-AURORA-EV","quantity":24}'
```

The key also works as a bearer token. Comparison is constant-time, so the
endpoint does not leak key material through response timing.

Set `PC_PROTECT_READS=true` to require the key on reads as well.

### Rate limit

The demo key is published, so a key alone does not stop a script hammering the
plant. State-changing requests are limited to `PC_RATE_LIMIT_WRITES` per minute
per client IP (default 120), counted **before** authentication so guessing keys
is limited too. Every write response carries `RateLimit-Limit` and
`RateLimit-Remaining`; past the limit the answer is `429 RATE_LIMITED` with
`Retry-After`. Reads are never limited.

## Errors

Every error has the same shape and a stable, branchable `code`:

```json
{
  "error": {
    "code": "QUALITY_HOLD",
    "message": "Unit 2NSAURE19TW000412 is held at BODY-50 by 1 open defect(s)",
    "details": {
      "vin": "2NSAURE19TW000412",
      "station": "BODY-50",
      "defects": [{ "id": "DEF-000317", "code": "DIM_OUT_OF_TOL", "severity": "CRITICAL" }]
    }
  },
  "requestId": "3f2a91c4-..."
}
```

| Code | HTTP |
|---|---|
| `VALIDATION_FAILED` | 400 |
| `MALFORMED_JSON` | 400 |
| `UNAUTHORIZED` | 401 |
| `NOT_FOUND` | 404 |
| `ROUTE_NOT_FOUND` | 404 |
| `INVALID_STATE_TRANSITION` | 409 |
| `CONFLICT` | 409 |
| `QUALITY_HOLD` | 409 |
| `RATE_LIMITED` | 429 |
| `INTERNAL_ERROR` | 500 |

Validation errors report **every** offending field at once:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Work order payload failed validation",
    "details": [
      { "field": "modelCode", "message": "unknown model 'NOPE'" },
      { "field": "quantity", "message": "quantity must be an integer in 1..2000" }
    ]
  }
}
```

Send `x-request-id` and it is echoed back on the response and included in the
error body, so a client-side trace id survives into the server log.

## Endpoint map

| Area | Endpoints |
|---|---|
| System | `/health` `/live` `/ready` |
| Plant model | `/plant` `/lines` `/stations` `/models` `/parts` `/boms/{model}` `/shifts` |
| Reference data | `/reference/defect-codes` `/reference/downtime-reasons` `/reference/andon-types` `/reference/inspection-plans` `/reference/maintenance-types` `/reference/state-machines` |
| Scheduling | `/work-orders` |
| Execution | `/units` |
| Feeder lines | `/sub-assemblies` |
| Quality | `/quality/inspections` `/quality/defects` `/quality/gate/{vin}/{station}` `/quality/summary` |
| Floor ops | `/andon` `/downtime` `/operations/summary` |
| Station control | `/stations/{id}/control` `/stations/{id}/start` `/stations/{id}/stop` `/stations/{id}/maintenance` `/stations/{id}/maintenance/complete` |
| Maintenance | `/maintenance` `/maintenance/due` `/maintenance/{id}` |
| KPIs | `/kpi/dashboard` `/kpi/oee` `/kpi/trend` `/kpi/calculate` |
| Traceability | `/trace/recall` `/trace/lots` `/trace/vehicle/{vin}` |
| Events | `/events` `/events/stream` |
| Simulator | `/simulator` `/simulator/{action}` |

---

## Worked examples

### Build a vehicle end to end

```bash
KEY='x-api-key: production-core-demo-key'
JSON='content-type: application/json'
API=localhost:1880/api/v1

# 1. Create a work order (starts in DRAFT)
WO=$(curl -s -X POST $API/work-orders -H "$KEY" -H "$JSON" \
  -d '{"modelCode":"NS-AURORA-EV","quantity":5,"colour":"Laurentian Blue"}' \
  | jq -r .id)

# 2. Release it. This mints vehicles, assigns VINs and opens genealogy records.
VIN=$(curl -s -X POST $API/work-orders/$WO/release -H "$KEY" -H "$JSON" \
  -d '{"createUnits":1}' | jq -r '.units[0].vin')

echo "building $VIN"

# 3. Walk it down the line. `advance` lets the plant model pick the next station.
for i in $(seq 1 27); do
  curl -s -X POST $API/units/$VIN/advance -H "$KEY" \
    | jq -r '.currentStation // .status'
done
```

Each `advance` also back-flushes the parts consumed at that station into the
vehicle's genealogy and installs any sub-assembly the station is due to fit.

### Watch a quality gate refuse a vehicle

```bash
# Raise a critical defect on a vehicle sitting at the body-shop gate
curl -s -X POST $API/quality/defects -H "$KEY" -H "$JSON" \
  -d "{\"code\":\"DIM_OUT_OF_TOL\",\"vin\":\"$VIN\",\"stationId\":\"BODY-50\"}"

# The gate now refuses to let it downstream
curl -s -X POST $API/units/$VIN/move -H "$KEY" -H "$JSON" \
  -d '{"stationId":"PAINT-10"}' | jq .error.code
# "QUALITY_HOLD"

# Ask the gate directly, without moving anything
curl -s $API/quality/gate/$VIN/BODY-50 | jq
# { "pass": false, "recommendation": "HOLD_OFFLINE", "blockingDefects": [...] }

# Disposition and close it, and the vehicle moves
curl -s -X POST $API/quality/defects/DEF-000317/disposition -H "$KEY" -H "$JSON" \
  -d '{"disposition":"REWORK","operator":"tech-9","repairMinutes":12}'
curl -s -X POST $API/quality/defects/DEF-000317/close -H "$KEY" -H "$JSON" -d '{}'
curl -s -X POST $API/units/$VIN/move -H "$KEY" -H "$JSON" \
  -d '{"stationId":"PAINT-10"}' | jq .currentStation
```

### Run an inspection

Measurements are keyed by characteristic id. Every characteristic in the plan is
required — a missing one is an error, not a pass.

```bash
curl -s -X POST $API/quality/inspections -H "$KEY" -H "$JSON" -d '{
  "stationId": "EOL-10",
  "vin": "'$VIN'",
  "inspector": "qa-201",
  "measurements": {
    "TOE-FRONT": 0.42,
    "CAMBER-FRONT": -0.5,
    "THRUST-ANGLE": 0.02
  }
}' | jq '{passed: .inspection.passed, defects: [.defects[].code]}'
```

```json
{ "passed": false, "defects": ["ALIGNMENT_OOS"] }
```

Toe is 0.42° against an upper limit of 0.3°, so the plan fails and raises the
defect its characteristic is mapped to.

### Recall analysis

The query the whole system exists to answer.

```bash
# What lots has the plant consumed?
curl -s "$API/trace/lots?limit=5" | jq '.items'

# Which vehicles contain one, and where are they now?
curl -s -X POST $API/trace/recall -H "$KEY" -H "$JSON" \
  -d '{"lotCode":"BREMBO-PN-BRAKE-FRONT-2638B","reason":"supplier alert 2026-09-17"}' \
  | jq '{affectedCount, byContainment, containableNow, estimatedRecallCostCad, recommendation}'
```

```json
{
  "affectedCount": 527,
  "byContainment": { "IN_PLANT": 3, "FINISHED_GOODS": 519, "SHIPPED": 0, "SCRAPPED": 5 },
  "containableNow": 522,
  "estimatedRecallCostCad": 260742,
  "recommendation": {
    "action": "CONTAIN_IN_PLANT",
    "rationale": "All 527 affected vehicle(s) are still under plant control; hold and rework before release"
  }
}
```

`containableNow` is the number that can still be stopped before they ship. That
is the only cheap column — a shipped vehicle costs roughly ten times as much to
put right.

Recommendations are `NO_ACTION`, `CONTAIN_IN_PLANT`, `FIELD_CAMPAIGN` or
`SAFETY_RECALL`; the last is reserved for a safety-critical part that has
already shipped.

You can also trace by sub-assembly serial or by part number:

```bash
curl -s -X POST $API/trace/recall -H "$KEY" -H "$JSON" \
  -d '{"serial":"PWT-26259-000412"}'      # exactly one vehicle

curl -s -X POST $API/trace/recall -H "$KEY" -H "$JSON" \
  -d '{"partNumber":"PN-BRAKE-FRONT"}'    # every vehicle with that part
```

### Read a vehicle's as-built record

```bash
curl -s $API/trace/vehicle/$VIN | jq '{
  vin,
  components: .genealogy.stats.totalNodes,
  subAssemblies: (.subAssemblies | length),
  lots: (.lotCodes | length),
  suppliers,
  sealed: .genealogy.sealedAt,
  cost: .materialCostCad
}'
```

`/units/{vin}/genealogy` returns the same tree with a flattened projection;
`/units/{vin}/history` returns the station-by-station route with cycle times and
variance against ideal.

### KPIs

```bash
# Everything the HMI shows, in one call
curl -s $API/kpi/dashboard | jq '.headline'

# Per-line OEE with the loss waterfall
curl -s $API/lines/MAINASM/oee | jq '{oee, availability, performance, quality, constraintStation, losses}'

# One station
curl -s $API/stations/CHAS-10/oee | jq '{oee, avgCycleSeconds, inputs, warnings}'

# Shift trend; `source` says whether a bar is recomputed detail or a stored aggregate
curl -s "$API/kpi/trend?shifts=8" | jq '.items[] | {key, source, partial, oee, unitsCompleted}'
```

All KPI endpoints accept `?since=` and `?until=` (ISO-8601). The default window
is the current shift — except in the first 20 minutes of a shift, when the
response widens to a rolling 8 hours and sets `window.rolling: true` with a
`rollingReason`, because "OEE 0%" for a shift that started two minutes ago is
correct and useless.

`/kpi/calculate` runs the OEE engine on figures you supply, with no plant data
involved — the same code the plant uses, so it is a way to check a number from
somewhere else, or to see the performance cap in action:

```bash
curl -s "$API/kpi/calculate?plannedBusySeconds=26400&downtimeSeconds=2520&idealCycleSeconds=60&totalCount=390&goodCount=378" \
  | jq '{availability, performance, quality, oee, rating, warnings}'
```

The OEE calculator on the [domain model page](DOMAIN-MODEL.md#kpis-iso-22400-2)
is this endpoint behind six sliders.

### Stop, start and maintain a station

Every control action returns the station's full control view, including the
actions that are legal *now* and the reason each other one is not:

```bash
curl -s $API/stations/BODY-20/control | jq '{state, control, allowedActions, blockedActions, pm}'

# Stop it for a planned reason - planned stops do not count against OEE
curl -s -X POST $API/stations/BODY-20/stop -H "$KEY" -H "$JSON" \
  -d '{"operator":"j.tremblay","reasonCode":"SHIFT_MEETING","reason":"Safety huddle"}'

# Anything automated is now refused, with who locked it and why
curl -s -X POST $API/stations/BODY-20/state -H "$KEY" -H "$JSON" -d '{"state":"RUNNING"}' | jq .error

curl -s -X POST $API/stations/BODY-20/start -H "$KEY" -H "$JSON" -d '{"operator":"j.tremblay"}'
```

Maintenance opens a work order with a checklist chosen by the station's
capability, and signing it off records what was actually done:

```bash
curl -s -X POST $API/stations/PAINT-30/maintenance -H "$KEY" -H "$JSON" \
  -d '{"type":"PREVENTIVE","technician":"a.singh","plannedMinutes":20}' | jq '.activeMaintenance | {id, checklist}'

curl -s -X POST $API/stations/PAINT-30/maintenance/complete -H "$KEY" -H "$JSON" \
  -d '{"technician":"a.singh","findings":"Filters replaced","checklist":["Replace booth intake filters"]}' \
  | jq '.completedOrder | {id, actualMinutes, overrunMinutes, checklistComplete}'

# What is due, most overdue first; and the order history
curl -s "$API/maintenance/due?dueOnly=true" | jq '.items[] | {stationId, usedPct, status}'
curl -s "$API/maintenance?status=COMPLETED&limit=5" | jq '.items[] | {id, stationId, type, actualMinutes}'
```

A refused action is a `409 INVALID_STATE_TRANSITION` carrying the same reason the
HMI shows as a tooltip. The model behind all of this is on the
[Station control](STATION-CONTROL.md) page.

### Live event stream

Server-sent events, not WebSocket: the feed is one-directional, and plain HTTP
survives every PaaS proxy without an extra port.

```bash
curl -N "$API/events/stream?type=unit,andon"
```

```js
const stream = new EventSource('/api/v1/events/stream');
stream.addEventListener('unit.moved', (e) => console.log(JSON.parse(e.data)));
stream.addEventListener('andon.raised', (e) => console.log(JSON.parse(e.data)));
```

`?type=` takes comma-separated **prefixes**, so `unit` matches every
`unit.*` event. Every envelope has the same shape:

```json
{
  "id": "m3k2p9x-001f",
  "type": "unit.moved",
  "timestamp": "2026-09-17T14:22:08.412Z",
  "severity": "info",
  "stationId": "CHAS-10",
  "lineId": "MAINASM",
  "vin": "2NSAURE19TW000412",
  "payload": { }
}
```

Severity is `info`, `success`, `warning` or `error`.

The historical log is queryable at `/events` with `type`, `severity`, `lineId`,
`vin`, `since` and `limit` filters, newest first.

### Drive the simulator

```bash
curl -s $API/simulator | jq '{running, speed, counters}'

curl -s -X POST $API/simulator/speed -H "$KEY" -H "$JSON" -d '{"speed":60}'
curl -s -X POST $API/simulator/stop  -H "$KEY"
curl -s -X POST $API/simulator/start -H "$KEY"

# Break a station and watch the andon board and OEE react
curl -s -X POST $API/simulator/inject-fault -H "$KEY" -H "$JSON" \
  -d '{"stationId":"PAINT-40","reasonCode":"ROBOT_FAULT","durationSeconds":300}'

# Raise a defect on a specific vehicle to demonstrate the gate
curl -s -X POST $API/simulator/inject-defect -H "$KEY" -H "$JSON" \
  -d '{"vin":"'$VIN'","code":"TORQUE_LOW"}'
```

---

## The flow-served API

Alongside `/api/v1`, a second set of endpoints is served **by the Node-RED flows
themselves**, under `/factory` — `http in` → domain node → `http response`.

| Endpoint | |
|---|---|
| `GET /factory/status` | Plant status as JSON |
| `GET /factory/board` | Line board, rendered HTML |
| `GET /factory/line/:id` | One line's KPIs |
| `GET /factory/vehicle/:vin` | Full vehicle trace |
| `POST /factory/andon` | Raise an andon call |
| `POST /factory/recall` | Run a recall query |

These exist to demonstrate the Node-RED `http-in` pattern. Because both APIs
call the same domain services, they cannot disagree about what the plant is
doing — which is the point being made. Open the **95 - Factory API** tab in
`/red` to see how they are wired.

## Pagination

List endpoints take `limit` (1–500, default 50), `offset`, `sort` and `order`,
and return:

```json
{ "items": [], "total": 1204, "limit": 50, "offset": 0 }
```

## OpenAPI and drift

The specification is **generated from the live plant model**, so the station
ids, model codes and defect codes in the documentation are exactly the ones the
running system accepts.

A contract test asserts in both directions that every route the Express router
serves appears in the document, and that the document contains no route that
does not exist. A Swagger page that has drifted from its implementation is worse
than no Swagger page, because people trust it.
