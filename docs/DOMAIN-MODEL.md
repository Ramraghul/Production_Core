# Domain model

Everything here lives in `src/core/` as pure functions over immutable
documents. No I/O, no framework, no database.

## The plant

`src/core/plantModel.js` is the single source of truth for the physical
factory. The flows, the simulator, the KPI engine and the REST API are all
generated from or driven by it — adding a station is an edit here, not forty
minutes of dragging nodes.

The hierarchy follows **ISA-95 / IEC 62264 part 2**:

```
Enterprise    NorthStar Motors
  └─ Site     Windsor Assembly Plant (Windsor, Ontario)
      └─ Area          BODY_SHOP · PAINT_SHOP · FEEDER
        │              GENERAL_ASSEMBLY · QUALITY
        └─ Work Centre (line)
            └─ Work Unit (station)
```

<!-- live:plant -->

### Lines

| Line | Kind | Takt | Stations | Purpose |
|---|---|---|---|---|
| `BODY` | main | 60 s | 5 | Underbody, framing, respot → body-in-white |
| `PAINT` | main | 62 s | 6 | E-coat, sealer, primer, base, clear, inspection |
| `DOOR` | feeder | 60 s | 5 | Doors removed after paint, trimmed offline, re-hung |
| `TIRE` | feeder | 60 s | 5 | Mount, inflate, balance, TPMS, runout |
| `SUBASM` | feeder | 60 s | 6 | Powertrain, cockpit, seats, corner modules |
| `MAINASM` | main | 60 s | 10 | Trim → chassis (marriage) → final |
| `QUALITY` | main | 60 s | 6 | Alignment, lamps, roll test, water, DTC, audit |

A vehicle travels the **main route** — 27 stations from `BODY-10` to `EOL-60`.
Feeder lines never appear on that route; they deliver serialised modules that
are married in at specific stations.

### A note on feeder takt

Feeder takt and cycle times are expressed **per delivered set**, not per piece.
The door line trims four doors per vehicle across four parallel lanes, so its
cycle time is quoted for the complete set. Counting the unit of output a line is
measured on is what keeps its OEE performance factor comparable with the main
line's — quoting per-door cycle times made the door line read 33% performance
when it was in fact keeping up perfectly.

### Integrity checks at boot

`assertPlantModelIntegrity()` runs at require time and throws on:

- a model descriptor containing `I`, `O` or `Q` (ISO 3779 excludes them)
- a `vds` that is not exactly 5 characters
- duplicate station ids
- a non-positive cycle time
- a serialised class whose install station does not exist

This caught a real bug during development: `BORH2` and `VOYC3` both contain
`O`, so every Borealis and Voyageur VIN would have been rejected by any decoder.
Failing loudly at boot beats discovering it three hours into a production run.

## Identity

### VINs

`src/core/ids.js` builds real **ISO 3779 / FMVSS 565** identifiers:

```
  2 N S   A U R E 1   9   T   W   0 0 0 4 1 2
  └─┬─┘   └───┬───┘   │   │   │   └────┬────┘
   WMI      VDS      chk  yr plant  sequence
    │                 │   │   │
    │                 │   │   └─ W = Windsor
    │                 │   └───── T = 2026
    │                 └───────── computed check digit
    └─────────────────────────── 2 = built in Canada
```

The position-9 check digit uses the standard transliteration table and weight
vector. The test suite validates the algorithm against the canonical NHTSA test
VIN `1M8GDM9AXKP042788` — a self-consistent but *wrong* implementation would
still validate its own output, so checking against an external known-good value
is the only assertion that proves anything.

### Serials and lots

```
ENG-26259-000412                 <prefix>-<YY><day-of-year>-<sequence>
MAGNA-PN-UB-FLOOR-2638C          <supplier>-<part>-<YY><ISO week><batch>
```

The Julian date in a serial makes shift-level lot analysis possible without a
join. The lot code is what recall analysis pivots on.

### Deterministic randomness

`createRandom(seed)` is a mulberry32 PRNG. The simulator and the seeder both run
off it, so a given `PC_SIM_SEED` always produces the same plant. That is what
makes the demo identical on every cold start and the tests assertable.

`normal()` is clamped to ±4σ — an unclamped tail value would eventually produce
a negative cycle time.

## Entities and their state machines

### Work order

The plant's commitment to build N units of one model by a date.

<!-- live:state-machine workOrder -->
```
DRAFT ──▶ RELEASED ──▶ IN_PROGRESS ──▶ COMPLETED
  │           │             │
  │           │             └──▶ ON_HOLD ──▶ IN_PROGRESS
  │           │
  └───────────┴─────────────────▶ CANCELLED
```

`COMPLETED` and `CANCELLED` are terminal. Releasing is **incremental** — calling
release again on an order already on the floor mints more units from it, up to
the order quantity, which is how a line pulls the next few vehicles instead of
materialising a 500-unit order at once.

`scheduleRisk()` answers the question a plant manager asks first: at the current
rate, will this order miss its due date, and by how many hours?

### Unit (vehicle)

One physical vehicle moving through the plant.

<!-- live:state-machine unit -->
```
PLANNED ──▶ IN_PROCESS ──▶ COMPLETED
               │  ▲
               ▼  │
             HOLD ─┴──▶ REWORK ──┐
               │                 │
               └─────────────────┴──▶ SCRAPPED
```

`COMPLETED` and `SCRAPPED` are terminal and irreversible, as in a real plant.

**Routing is enforced.** `moveToStation` only accepts the next station on the
route. Re-entering the same station is allowed — that is a rework loop. `force`
bypasses the check and is recorded as an audited override
(`lastOverrideAt` / `lastOverrideBy`).

**Completion has preconditions.** Only legal from the terminal station
(`EOL-60`), and only with no open defects.

Every station visit is an immutable history entry:

```js
{
  stationId, stationName, lineId,
  enteredAt, exitedAt,
  dwellSeconds, cycleSeconds, idealCycleSeconds,
  cycleVarianceSeconds,   // positive = slower than ideal, a performance loss
  result,                 // PASS | FAIL | REWORKED | SKIPPED
  operator
}
```

That history is what makes "where was VIN X at 03:14 and who touched it"
answerable, which is the reason a plant runs an MES rather than a spreadsheet.

**First pass** means `reworkCount === 0` *and* every visit resulted in `PASS`.
Counting reworked units as good turns the quality factor into a measure of how
good the repair shop is, which is not what anyone wants to know.

### Sub-assembly

Feeder lines build serialised modules — a dressed powertrain, a cockpit, a
balanced wheel set — each with its own genealogy before it is married in.

<!-- live:state-machine subAssembly -->
```
BUILDING ──▶ AVAILABLE ──▶ ALLOCATED ──▶ CONSUMED
    │            │             │
    └────────────┴─────────────┴──▶ QUARANTINED ──▶ SCRAPPED
```

Two rules matter:

**Single consumption.** Once `CONSUMED` by a VIN, a serial can never be consumed
again. That one constraint is what stops the same powertrain appearing in two
vehicles' service records.

**Broadcast vs stock.** A `BROADCAST` module is built against a specific VIN and
the domain refuses to fit it to any other. Door sets are broadcast-built because
the doors physically came off that body. A `STOCK` module is pulled from a
buffer at the point of use.

| Class | Built at | Installed at | Mode |
|---|---|---|---|
| `PWT` | `SUB-ENG-20` | `CHAS-10` | stock |
| `CKP` | `SUB-CKP-10` | `TRIM-20` | stock |
| `SET` | `SUB-SEAT-10` | `FINAL-20` | stock |
| `CNF` | `SUB-SUSP-10` | `CHAS-20` | stock |
| `CNR` | `SUB-SUSP-20` | `CHAS-20` | stock |
| `DRS` | `DOOR-50` | `FINAL-30` | **broadcast** |
| `WHS` | `TIRE-50` | `FINAL-10` | stock |

A module that fails its functional test is `QUARANTINED` and can never be
fitted. The refusal carries the quarantine *reason* — "failed the hot test"
tells an operator what to do, where "cannot move QUARANTINED → CONSUMED" does
not.

### Genealogy

The as-built record: what physically went into a vehicle.

```
VIN 2NSAURE19TW000412
 ├─ PART  PN-WINDSHIELD    lot AGC-PN-WINDSHIELD-2637A       @ TRIM-30
 ├─ SUB   PWT-26259-000412                                   @ CHAS-10
 │   ├─ PART PN-ENGINE-BLOCK  lot NORTHSTAR-PT-...-2636B
 │   └─ PART PN-ALTERNATOR    lot DENSO-...-2637A
 └─ SUB   WHS-26259-000410                                   @ FINAL-10
     └─ PART PN-TIRE-235      lot BRIDGESTONE-...-2635C
```

It is a **tree**, not a list: a vehicle contains serialised sub-assemblies, and
those contain their own lot-coded parts. A technician holding only the VIN can
see the lot code of a part two levels down.

The record is **append-only** and is **sealed** at vehicle release. Writing to a
sealed record throws. Evidence that can be edited is not evidence.

A `lotIndex` and `serialIndex` are maintained on the document as it is built, so
recall lookups are O(1) rather than a tree walk.

### Quality

**Defect catalogue** — 30 codes across 6 families, each with a default severity
and the stations it typically occurs at:

| Family | Examples |
|---|---|
| `BODY` | `WELD_MISSING`, `GAP_FLUSH_OOS`, `DIM_OUT_OF_TOL` |
| `PAINT` | `DIRT_INCLUSION`, `RUN_SAG`, `ORANGE_PEEL`, `FISH_EYE` |
| `ASSEMBLY` | `TORQUE_LOW`, `MISSING_FASTENER`, `HARNESS_UNSEATED` |
| `ELECTRICAL` | `DTC_PRESENT`, `MODULE_NO_COMM`, `TPMS_NO_SIGNAL` |
| `TRIM` | `SCRATCH`, `RATTLE_BSR`, `WATER_LEAK` |
| `FUNCTIONAL` | `ALIGNMENT_OOS`, `BRAKE_IMBALANCE`, `HOT_TEST_FAIL` |

**Severity** is `CRITICAL` (safety or regulatory — cannot ship), `MAJOR`
(function or appearance — must be repaired), `MINOR` (cosmetic — may ship with
concession).

**Inspection plans** — 11 plans with real spec windows. `runInspection()`
evaluates every characteristic against its limits and raises a defect per
failure:

```js
'IP-EOL-ALIGN': {
  characteristics: [
    { id: 'TOE-FRONT',    uom: 'deg', nominal: 0.15, lowerLimit: 0.0,  upperLimit: 0.3 },
    { id: 'CAMBER-FRONT', uom: 'deg', nominal: -0.5, lowerLimit: -1.1, upperLimit: 0.1 },
    { id: 'THRUST-ANGLE', uom: 'deg', nominal: 0,    lowerLimit: -0.15, upperLimit: 0.15 }
  ]
}
```

A missing measurement is an error, not a pass. Silently skipping an unmeasured
characteristic is how an inspection plan becomes theatre.

**Disposition** is the decision that costs money, so it is recorded with who
made it: `REWORK`, `REPAIR`, `SCRAP`, `USE_AS_IS`, `RETURN_TO_SUPPLIER`.

A `CRITICAL` defect can **never** be dispositioned `USE_AS_IS` without an
engineering deviation — the domain rejects it outright.

A defect's own lifecycle, from detection to closure:

<!-- live:state-machine defect -->

**The gate rule**: a gate blocks on any open `CRITICAL`, and on any `MAJOR` that
has not been dispositioned. `MINOR` never blocks.

### Andon

The cord an operator pulls when something is wrong.

<!-- live:state-machine andon -->
```
RAISED ──▶ ACKNOWLEDGED ──▶ RESOLVED
   │            │
   ├────────────┴──▶ ESCALATED ──▶ ACKNOWLEDGED ──▶ RESOLVED
   │
   └──▶ CANCELLED
```

`RAISED → RESOLVED` directly is legal: someone fixes the problem and clears the
cord without pressing acknowledge, which happens constantly on a real floor. The
response time is then derived from the resolution, so the call still counts
against its SLA instead of vanishing.

| Call type | SLA | Stops line |
|---|---|---|
| `SAFETY` | 30 s | yes |
| `QUALITY` | 120 s | yes |
| `MAINTENANCE` | 150 s | yes |
| `MATERIAL` | 180 s | no |
| `PROCESS` | 240 s | no |
| `TOOLING` | 300 s | no |

What matters is not how many cords were pulled but **how fast help came**.
Response time against SLA, and escalation when the SLA is blown, are the two
things modelled. The ladder is team leader → area supervisor (5 min) → plant
manager (15 min).

### Downtime

Reason codes aligned to **ISO 22400**, each mapped to one of the Six Big Losses.

The distinction that matters for OEE is planned vs unplanned. A planned stop
comes out of both the numerator *and* the denominator of availability; an
unplanned stop only comes out of the numerator, which is why it hurts.

Reliability metrics count **only** `BREAKDOWN`-class stops as failures. A
material shortage is not an equipment reliability event, and folding it into
MTBF makes MTBF meaningless.

The downtime Pareto ranks by **minutes lost, not occurrence count** — one
90-minute breakdown outranks thirty 30-second jams, and the ranking should say
so.

`OPERATOR_STOP` is the reason an unexplained manual stop falls back to. It is
unplanned and counts against OEE, but it has no Big Loss attached — the operator
knows why they stopped the station, and the reason picker exists so they say
so. A stop recorded with a planned reason (a break, a meeting, a trial) comes out
of planned time instead, exactly like any other planned stop.

### Station control and maintenance

Operator start and stop, lockout, maintenance work orders and PM scheduling
have their own page: [Station control](STATION-CONTROL.md).

## KPIs (ISO 22400-2)

<!-- live:oee-calc -->
```
Availability = Actual production time / Planned busy time
Performance  = Ideal cycle time × Total count / Actual production time
Quality      = First-pass good count / Total count
OEE          = Availability × Performance × Quality
```

Three details separate a correct implementation from a wrong one:

**Performance is capped at 1.0.** A station reporting more output than its ideal
cycle time allows means the cycle time is wrong, not that the station is
superhuman. The value is capped and a `PERFORMANCE_CAPPED` warning attached,
rather than letting bad master data silently inflate plant OEE.

**Good count is first-pass only.** See the note under *Unit* above.

**A line is not the average of its stations.** Availability and performance come
from the constraint station; quality *compounds* along the route. Forty stations
at 99% each is 67% rolled throughput yield.

The result also carries a **loss waterfall** in seconds, which sums back exactly
to net planned time — availability loss, performance loss, quality loss, and
value-adding time. That identity is asserted in the test suite as an internal
consistency check.

Also computed: TEEP, throughput and takt adherence, FPY, rolled throughput
yield, DPMO and an approximate sigma level (Acklam's inverse-normal, with the
conventional 1.5σ shift).

## Shifts

Three 8-hour shifts covering all 24 hours, in the site timezone
(`America/Toronto`), handled through `Intl` rather than a date library — no
dependency, and DST stays correct.

| Shift | Local hours | Breaks | Notes |
|---|---|---|---|
| A | 06:00 – 14:00 | 40 min | |
| B | 14:00 – 22:00 | 40 min | |
| C | 22:00 – 06:00 | 50 min | maintenance window |

Shift C wraps midnight, which is why the window comparison is split.

**Planned busy time** is shift length minus scheduled breaks — the denominator
of OEE availability per ISO 22400-2.

## Errors

A small taxonomy, each carrying a `status` the API maps straight onto HTTP and a
stable `code` callers can branch on:

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Payload rejected; `details` lists every offending field at once |
| `UNAUTHORIZED` | 401 | Write attempted without a valid API key |
| `NOT_FOUND` | 404 | No such entity |
| `INVALID_STATE_TRANSITION` | 409 | Legal operation, illegal from the current state |
| `CONFLICT` | 409 | e.g. a broadcast module fitted to the wrong VIN |
| `QUALITY_HOLD` | 409 | A gate refused to pass the unit; `details.defects` says why |

Validation reports **all** problems at once rather than one per round trip.
