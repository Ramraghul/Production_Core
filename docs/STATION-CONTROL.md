# Station control

Operators can start and stop any of the 43 stations, and technicians can take a
station into maintenance under a work order with a checklist. A station that a
person is in charge of is **locked**: nothing automated — the simulator, a flow,
a line controller — can restart it.

<!-- live:pm-board -->

## Two dimensions, not one

A station has two independent properties, and keeping them apart is the design:

| | What it says | Who changes it | Values |
|---|---|---|---|
| **State** | What the station is physically doing | The plant (simulator, PLC, flows) | `RUNNING` `IDLE` `STARVED` `BLOCKED` `DOWN` `STOPPED` `MAINTENANCE` `CHANGEOVER` |
| **Control mode** | Who is in charge of it | People | `AUTO` `STOPPED` `MAINTENANCE` |

Folding them into one enum looks simpler and is wrong. A station an operator
stopped and a station that starved are both "not running", but only one of them
may be restarted by the line. With two dimensions the rule is one line of code:
**any mode other than `AUTO` is a lockout.**

## The control modes

<!-- live:state-machine stationControl -->
```
AUTO ──stop──────────▶ STOPPED ──start──▶ AUTO
  │                       │
  └──maintenance──┐   maintenance
                  ▼       ▼
                MAINTENANCE ──completeMaintenance──▶ AUTO
```

The table above is the shape. The finer rules come from
`stationControl.availableActions()`, which returns both what is allowed and,
for everything else, **why not**:

| Action | Refused when | Reason given |
|---|---|---|
| `start` | in maintenance | Complete the maintenance order first |
| `start` | down with an open andon | Resolve andon ANDON-… first |
| `start` | already running in AUTO | Already in service (RUNNING) |
| `stop` | in maintenance | Station is under maintenance |
| `stop` | already stopped | Already stopped |
| `stop` | down on a fault | Station is already down on a fault |
| `maintenance` | already in maintenance | Maintenance already in progress |
| `completeMaintenance` | not in maintenance | No maintenance in progress |

The HMI renders its control buttons from this function, and the refusal reason
is the button's tooltip. The API calls the same function before acting and
returns the same reason in a `409`. So the panel can never offer an action the
service would refuse, and a refused action always says what to do instead.

A test walks every mode and asserts that `availableActions()` and the transition
table agree, so the diagram above cannot drift from the behaviour.

## What the lockout covers

The rule is enforced in the service layer, so every caller gets it:

- **`operations.setStationState`** refuses automated changes to a locked
  station, naming who locked it and why:
  `Station BODY-20 is locked in STOPPED by j.tremblay; start it before changing its state`.
  Only an explicit `override` gets through.
- **`production.moveUnit`** refuses to route a vehicle *into* a locked station.
  The vehicle upstream waits, and the upstream station goes `BLOCKED` — which is
  what really happens when you stop a station on a moving line.
- **The simulator** skips locked stations when it injects faults, reconciles
  states and handles andons. A random draw cannot "repair" a station a
  technician has open.

A stop is not a pause button for the whole line. Stopping `CHAS-10` starves
everything downstream of it and blocks everything upstream, in real time, and
the line OEE on the dashboard drops accordingly.

## Stopping a station

A stop takes an optional reason code. The code decides how the stop is
accounted for:

| Reason | Category | Counts against OEE |
|---|---|---|
| `SCHEDULED_BREAK`, `SHIFT_MEETING`, `NO_SCHEDULE`, `TRIAL_BUILD` | Planned | No — comes out of planned busy time |
| `OPERATOR_STOP` (the default), or any unplanned reason | Unplanned | Yes — an availability loss |

The HMI groups the reasons into planned and unplanned and shows the OEE impact
next to the picker, because the operator choosing the reason is the one person
who knows which it is.

```bash
curl -s -X POST localhost:1880/api/v1/stations/BODY-20/stop \
  -H "x-api-key: production-core-demo-key" -H "content-type: application/json" \
  -d '{"operator":"j.tremblay","reasonCode":"SHIFT_MEETING","reason":"Safety huddle"}'
```

Every control action returns the station's full control view — state, mode,
allowed and blocked actions, PM status, any open order — so a panel redraws
from the response without a second request:

```bash
curl -s localhost:1880/api/v1/stations/BODY-20/control | jq '{state, control, allowedActions, blockedActions}'
```

### Auto-release

On a public demo anyone can press Stop, and a station stopped and forgotten
would starve the line for the rest of the shift. So the simulator plays the
plant's people as well as its machines:

- a supervisor releases an operator stop after `PC_SIM_AUTO_RELEASE_MINUTES`
  (default 15), recorded as `supervisor (auto-release)`;
- the maintenance crew signs an order off once its planned time has run, with
  every checklist task done.

Both are measured in plant time, so they scale with `PC_SIM_SPEED`. Set the
variable to `0` to switch both off — what you want when driving the plant by
hand, or demonstrating a lockout that stays put.

## Maintenance

Maintenance is a mode, a downtime record and a **maintenance work order**
(`MWO-000123`), created together and closed together.

| Type | Default time | Downtime reason | OEE |
|---|---|---|---|
| `PREVENTIVE` | 20 min | `PREVENTIVE_MAINT` (planned) | Not counted — scheduled in advance |
| `PREDICTIVE` | 15 min | `PREVENTIVE_MAINT` (planned) | Not counted — condition-based |
| `CORRECTIVE` | 30 min | `EQUIP_FAILURE` (unplanned) | Counted, and an MTBF / MTTR event |

Starting **corrective** maintenance on a station that is `DOWN` keeps the
existing failure downtime open instead of closing it and opening another: a
repair is the tail end of the failure, and splitting it in two would halve the
MTTR. Starting preventive maintenance closes any open downtime and opens a
planned one.

```bash
curl -s -X POST localhost:1880/api/v1/stations/PAINT-30/maintenance \
  -H "x-api-key: production-core-demo-key" -H "content-type: application/json" \
  -d '{"type":"PREVENTIVE","technician":"a.singh","plannedMinutes":20}'
```

### The work order

<!-- live:state-machine maintenanceOrder -->
```
IN_PROGRESS ──▶ COMPLETED
     │
     └──────▶ CANCELLED
```

Each order carries a **checklist chosen by what the station physically does** —
a weld cell gets tip dressing and cooling-water checks, a paint booth gets bell
cup cleaning and filter changes, a test cell gets a master-part verification run:

| Capability | Example tasks |
|---|---|
| Weld | Dress or replace weld tips · Verify cooling-water flow · Check robot TCP |
| Paint | Clean the bell cup · Replace booth intake filters · Flush colour-change valves |
| Torque | Calibrate the nutrunner against the transducer · Verify the angle encoder |
| Test | Run the master-part verification cycle · Back up the test program |
| Inspect | Clean camera lenses · Run the calibration artefact · GR&R spot check |
| Assemble | Lubricate carrier guides · Check pneumatic lines · Verify error-proofing |

Signing off records what was actually done. Tasks not ticked are stored as
not done and the order is marked `checklistComplete: false`, which is how an
audit spots a skipped step. It also records actual against planned time — the
overrun is what a maintenance planner reviews each week.

```bash
curl -s -X POST localhost:1880/api/v1/stations/PAINT-30/maintenance/complete \
  -H "x-api-key: production-core-demo-key" -H "content-type: application/json" \
  -d '{"technician":"a.singh","findings":"Bell cup worn, replaced","partsReplaced":["BELL-CUP-65"],
       "checklist":["Clean and inspect the bell cup","Replace booth intake filters"]}'
```

Completing maintenance ends the downtime, resolves any andon the order was
responding to, resets the station's PM counter, and returns it to `AUTO` —
`RUNNING` if a vehicle is sitting in it, `IDLE` if not.

## Preventive-maintenance scheduling

Each station has a PM interval in cycles, derived from its reliability:

```
interval = max(50, MTBF_seconds / cycle_seconds × 1.5)
```

A weld station that fails every 300 minutes at a 58-second cycle is serviced
about every 465 cycles — roughly once a shift. A sturdy inspection station with
a 1400-minute MTBF goes about five shifts.

| Status | Interval used |
|---|---|
| `OK` | under 80% |
| `DUE_SOON` | 80% or more |
| `DUE` | 100% or more |
| `OVERDUE` | 120% or more |

### Skipping PM is not free

Past its interval, a station's failure hazard rises — linearly from 1× at 100%
of the interval to 3× at 200%. The simulator applies this **wear factor** to
every fault draw, so a plant that ignores the PM board sees more breakdowns,
more unplanned downtime and a lower OEE. That makes the trade-off a planner
actually faces visible in the numbers, rather than maintenance being a cost with
no benefit.

```bash
curl -s "localhost:1880/api/v1/maintenance/due?dueOnly=true" | jq '.items[:5]'
```

## Four ways to control a station

All four go through the same four service calls, so they cannot disagree.

| Surface | How |
|---|---|
| **Plant HMI** | Stations tab → click a station. The drawer shows state, mode, the buttons that are legal now, the PM gauge, the station's shift OEE and its maintenance history. The checklist is ticked in place and survives the background refresh. |
| **REST API** | `POST /stations/{id}/start`, `/stop`, `/maintenance`, `/maintenance/complete` — see [the API reference](API.md) or Swagger. |
| **Node-RED** | The `pc-station` node has `control`, `start`, `stop`, `maintenance`, `completeMaintenance` and `pmStatus` operations. |
| **MQTT** | Publish to `northstar/win/<line>/<station>/cmd`; the reply arrives on `…/cmd/ack`. |

### The MQTT command channel

The `85 - Maintenance` flow tab subscribes to `northstar/win/+/+/cmd`, validates
the command and replies on the matching `/ack` topic:

```json
{
  "command": "stop",
  "apiKey": "production-core-demo-key",
  "operator": "line-plc-7",
  "reasonCode": "SCHEDULED_BREAK"
}
```

The API key travels in the payload and is checked in the flow **before** the
command reaches a service, so a client that knows the topic tree still cannot
stop a station without the key. Every reply says what happened:

```json
{ "ok": false, "stationId": "BODY-20", "command": "stop",
  "error": { "code": "INVALID_STATE_TRANSITION", "message": "Cannot stop BODY-20: Already stopped" } }
```

Commands are `start`, `stop`, `maintenance` (with `type`, `plannedMinutes`,
`technician`) and `completeMaintenance` (with `findings`, `checklist`). The same
tab publishes a **retained** PM board to `northstar/win/plant/maintenance/due`
every minute, so a client that subscribes late still gets the current list.

## Events

| Event | When |
|---|---|
| `station.stopped` | An operator stopped a station |
| `station.started` | An operator (or the auto-release) started it again |
| `maintenance.started` | A maintenance order opened |
| `maintenance.completed` | An order was signed off; carries actual time, overrun and checklist result |

They flow through the event bus like everything else: into the event log, onto
MQTT under `northstar/win/plant/event/…`, to the HMI's live feed, and into the
shift KPIs.
