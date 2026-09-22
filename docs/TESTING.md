# Testing

387 tests across fourteen Jest suites plus a real-process smoke test.

```bash
npm test               # everything
npm run test:unit      # domain core, store, seeder, simulator
npm run test:api       # REST API through real HTTP
npm run test:nodes     # custom nodes in a real Node-RED runtime
npm run test:contract  # drift detection
npm run test:coverage  # with thresholds
npm run smoke          # boot the full stack and drive it
```

## The layers, and what each one proves

| Suite | Tests | What it proves |
|---|---|---|
| `test/unit/ids` | 19 | VIN generation matches ISO 3779 against an **external** known-good value |
| `test/unit/oee` | 17 | The ISO 22400 arithmetic, including the cases that are easy to get subtly wrong |
| `test/unit/stateMachines` | 28 | Illegal transitions are refused, terminal states are terminal |
| `test/unit/core` | 58 | Plant model integrity, BOM, genealogy, quality catalogue, downtime, andon, shifts |
| `test/unit/production` | 36 | The rules that span entities — gates, back-flush, genealogy, recall |
| `test/unit/store` | 30 | Repository semantics, ring-buffer caps, snapshot round-trip, seeder determinism |
| `test/unit/simulator` | 23 | Fault model distributions, tick behaviour, the repair-bay drain |
| `test/unit/stationControl` | 33 | Operator control, lockout from every direction, maintenance orders, PM scheduling, and the simulator respecting all of it |
| `test/api/rest` | 43 | The API through real HTTP, including every error path |
| `test/api/deployment` | 19 | The Vercel path: serverless defaults, Node-RED and MQTT never loaded, full-runtime paths explained or redirected, a frozen simulator catching up, the event stream ending before the platform limit, the write rate limit, and `vercel.json` pointing at real files |
| `test/api/docs` | 27 | The docs site: rendering, content negotiation, widgets, source-browser traversal refusal, and the reference endpoints behind the diagrams |
| `test/nodes/customNodes` | 26 | The custom nodes inside a real headless Node-RED runtime |
| `test/contract/openapi` | 13 | **Spec and implementation agree, both ways** |
| `test/contract/flows` | 15 | `flows.json` matches its spec byte for byte, and is structurally loadable |

Coverage is ~80% statements, ~82% lines, with a higher threshold on
`src/core/` (85%) because that is the part that must stay correct.

## The tests worth reading

### The VIN check digit is validated against something external

```js
it('validates a known-good real-world VIN', () => {
  expect(ids.isValidVin('1M8GDM9AXKP042788')).toBe(true);
});
```

A self-consistent but **wrong** check-digit implementation would happily
validate its own output. Checking against the canonical NHTSA test VIN is the
only assertion here that proves anything. The tampered-digit case proves it
actually rejects.

### The OEE loss waterfall must balance

```js
expect(result.losses.accountedSeconds).toBe(result.inputs.netPlannedSeconds);
```

Availability loss + performance loss + quality loss + value-adding time must sum
back exactly to net planned time. If any of the four is computed wrongly, this
fails — which is a much stronger check than asserting each number separately.

### ...even when performance is capped

```js
it('caps the waterfall with performance, so it still balances and agrees with OEE', () => {
  // 900 units at a 60 s cycle in 398 minutes of run time is 226% performance.
  ...
  expect(l.accountedSeconds).toBe(result.inputs.netPlannedSeconds);
  expect((l.valueAddingSeconds / result.inputs.netPlannedSeconds) * 100).toBeCloseTo(result.oee, 1);
});
```

The balance test above only ever used a plausible shift, and that is where a
bug hid. With performance capped, the OEE was right but the waterfall still used
the uncapped ideal run time — so value-adding time came out at 873 minutes of a
440-minute shift. The OEE calculator in the docs, which draws the waterfall from
the real engine, made it visible the first time someone dragged a slider to the
end. The fix caps the waterfall with performance, and the test now pins the
identity that should have been asserted from the start: value-adding time as a
share of planned time **is** the OEE.

### Performance above 100% is a master-data bug, not a fast station

```js
it('caps performance at 100% and warns that the cycle time is wrong', () => {
  // 200 units of 60 s in one hour is physically impossible.
  const result = oee.calculateOee({
    plannedBusySeconds: 3600, totalCount: 200, goodCount: 200, idealCycleSeconds: 60
  });
  expect(result.performance).toBe(100);
  expect(result.warnings[0].code).toBe('PERFORMANCE_CAPPED');
});
```

### A line must be worse than its worst station

```js
it('compounds quality along the route, so the line is worse than any station', () => {
  const line = oee.rollUpLine(stations);
  expect(line.quality).toBeLessThan(Math.min(...stations.map(s => s.quality)));
});
```

Averaging station quality is the common mistake. Quality compounds — a defect at
any station spoils the unit.

### Contract drift, in both directions

```js
it('documents every route the API actually serves', () => { … });
it('does not document routes that do not exist', () => { … });
```

The test walks the Express router stack, converts `:id` to `{id}`, and compares
against the OpenAPI paths both ways. A Swagger page that has drifted from its
implementation is worse than no Swagger page, because people trust it.

### The flows are deterministic and structurally valid

```js
it('is committed and matches the spec byte for byte', () => {
  expect(fs.readFileSync(FLOW_FILE, 'utf8')).toBe(`${JSON.stringify(flows, null, 2)}\n`);
});

it('gives every function node syntactically valid code', () => {
  for (const node of flows.filter(f => f.type === 'function')) {
    Function('msg', 'node', 'flow', 'global', 'context', 'env', node.func);
  }
});
```

Forty-seven `function` nodes contain real JavaScript written as strings in the
spec file. Compiling each one catches a syntax error at test time rather than at
flow start, where it would appear as a silently dead branch.

### The seeder must never produce an empty demo

```js
it('produces KPIs inside plausible bounds', () => { … });
it('never leaves a station reporting DOWN with no downtime record', () => { … });
it('seeds vehicles that satisfy their own domain rules', () => { … });
```

The last one re-validates every seeded VIN and asserts no completed vehicle
carries an open defect — i.e. the generated data obeys the same rules the live
system enforces.

### The buttons, the API and the diagram cannot disagree

```js
it('agrees with the documented transition table in every mode', () => {
  for (const [mode, state] of Object.entries(modes)) {
    const fromTable = control.CONTROL_TRANSITIONS.filter((t) => t.from === mode).map((t) => t.action).sort();
    const { allowed } = control.availableActions(stationState({ state, control: { mode } }));
    expect(allowed.sort()).toEqual(fromTable);
  }
});
```

Station control has three consumers of the same rule: the HMI draws its buttons
from `availableActions()`, the API refuses anything it does not allow, and the
docs draw the state diagram from `CONTROL_TRANSITIONS`. This test holds the
function and the table together, and the docs suite checks that every diagram a
page asks for exists in `/api/v1/reference/state-machines` — so none of the three
can quietly drift.

### Lockout holds against every automated caller

The station-control suite drives the lockout from each direction that could
break it: `setStationState` without `override`, `moveUnit` into a locked
station, and the simulator — which must not cycle, restart or repair a locked
station, must block the station *upstream* of a stopped one rather than roll a
vehicle into it, and must release an abandoned stop only after the configured
time. The last is tested with a back-dated stop rather than a sleep.

### Seeded orders must agree with their vehicles

```js
expect(units.length).toBeLessThanOrEqual(order.quantity);
expect(order.quantityStarted).toBe(units.filter((u) => u.startedAt).length);
```

Found in the smoke test's *log*, not its results: all 22 checks passed while
the simulator logged a failed tick every 250 ms. Vehicles still on the line at
boot, and the live work in progress, were seeded without bumping their order's
`quantityStarted` — and the WIP could overfill an order (32 vehicles on an order
for 19). The simulator judged capacity by the counter, the release judged it by
the vehicles, so it chose an order the release refused, every tick, and the line
quietly stopped launching. The seeder now keeps the counters true and puts the
WIP on an order with room; the simulator judges capacity the same way the
release does; and this test pins the invariant for one and three seeded shifts.

### The repair bay must drain

```js
it('never leaves a vehicle stuck on hold forever', () => {
  runTicks(simulator, 1500);
  const peak = countHeld();
  runTicks(simulator, 1500);
  expect(countHeld()).toBeLessThanOrEqual(Math.max(peak, 5));
});
```

This is a regression test for a real bug: held vehicles were dropped from the
simulator's occupancy map and never repaired, so they accumulated at the end of
the line and backed the whole quality line into a cascade of blocked stations.

### A simulator bug must not take the plant down

```js
it('survives a tick that throws, rather than taking the plant down', () => {
  jest.spyOn(ctx.production, 'moveUnit').mockImplementation(() => {
    throw new Error('simulated failure');
  });
  expect(() => runTicks(simulator, 5)).not.toThrow();
});
```

Same principle as the event bus: a subscriber that fails must not be able to
stall a production line.

## Custom nodes run in a real Node-RED runtime

`test/nodes` uses `node-red-node-test-helper`, which starts an actual headless
Node-RED. What is under test is the node **as the editor loads it**, not a
hand-rolled stand-in:

```js
const flow = [
  { type: 'pc-quality-gate', id: 'n1', z: 'f1', mode: 'evaluate', wires: [['pass'], ['hold']] },
  { id: 'pass', z: 'f1', type: 'helper' },
  { id: 'hold', z: 'f1', type: 'helper' },
  { id: 'f1', type: 'tab', label: 'test' }
];
```

Including the context-guard case, which asserts that a node loaded without the
application booted produces a specific, actionable error rather than a confusing
`undefined`, and the station-control operations — a refused command (stopping a
station that is already stopped) must come out on `msg.error` rather than
throwing, because the MQTT command channel has to acknowledge every command.

## The documentation site is tested like the API

`test/api/docs` treats `/docs` as an interface, because it is one:

- every catalogued page renders, with navigation to every other;
- **content negotiation** — the same URL returns HTML to a browser and markdown
  to a tool;
- a live marker claims a code block only when it sits on the line directly above
  it, and the ASCII fallback is kept;
- the **source browser refuses** `.env`, `node_modules`, `data/` and every
  traversal form tried — `..`, `%2e%2e`, `..%2f` — checked both over HTTP and at
  the resolver, which also compares real paths so a symlink cannot lead out.

## The smoke test

`npm run smoke` boots the **whole application in a real process** — store,
embedded MQTT broker, Express, Node-RED and the simulator — and runs 22 checks
over HTTP and MQTT.

It lives outside Jest deliberately. `aedes` 1.x is pure ESM, and Jest's CJS
module registry cannot `require()` ESM until Node 24.9. Running it in a plain
Node process also gets the Node-RED runtime and the real HTTP stack under test,
which the unit suites deliberately stub out.

```
HTTP        health · readiness · plant hierarchy · KPI · auth · OpenAPI · Swagger · HMI
Domain      VIN validity · routing enforcement · quality gate · genealogy · recall
MQTT        broker connection · topic tree · retained plant status from the flows
Node-RED    runtime running · editor reachable · flow-served API · flow-served HTML
Simulator   plant is producing · injected fault stops a station
```

It **found a real bug**: the flows' MQTT broker config hardcoded port 1883, so
running on any other port left every MQTT node connected to a different instance
and flapping every five seconds. Nothing in the unit suites could have caught
that — it only exists when the real runtime reads the real flow file.

## Determinism

Everything runs off a seeded PRNG (`PC_SIM_SEED`), so the seeder and simulator
produce identical output for identical input:

```js
it('runs deterministically for a given seed', () => {
  const a = new Simulator(makeContext(), { seed: 777 });
  const b = new Simulator(makeContext(), { seed: 777 });
  a.start(); b.start();
  runTicks(a, 300); runTicks(b, 300);
  expect(a.counters.stationCycles).toBe(b.counters.stationCycles);
});
```

Statistical properties — failure rates, model mix, weighted picks — are asserted
as **bands**, not point values, so they do not become flaky.

## Test configuration

`test/setup.js` forces an in-memory store, a silent logger, a fixed seed, and
disables the simulator, MQTT and Node-RED. No suite writes to disk or opens a
port unless it means to.

Jest runs `--runInBand`: several suites start a real HTTP server and the
embedded broker, and parallel workers would race for a port.

## What is deliberately not tested

- **The HMI JavaScript.** It is presentation over a tested API. A browser-driver
  suite would be slow and brittle for what it would prove.
- **Node-RED itself.** The flows are validated structurally and the nodes are
  tested in a real runtime; re-testing Node-RED's own execution engine is not
  this project's job.
- **Exact simulator output.** Determinism and bounds are asserted; specific
  values are not, because they should be free to change.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on Node 18, 20
and 22 — 18 is the floor declared in `package.json` engines and 22 is what the
Docker image ships, so the floor stays honest.

```
test    → verify:flows · lint · test · coverage
smoke   → boot the full stack and drive it
docker  → build the image, run it, check it serves the API, flows and docs
```

`verify:flows` runs first: if `flows/flows.json` has drifted from its spec —
someone edited it by hand, or forgot to rebuild — the pipeline fails before
anything else runs.
