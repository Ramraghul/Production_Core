# Runbook

Operating Production Core: what to check, what breaks, and what to do about it.

## Is it healthy?

```bash
curl -s localhost:1880/api/v1/health | jq
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptimeSeconds": 3812,
  "memory": { "rssMb": 162.4, "heapUsedMb": 94.1 },
  "store": {
    "driver": "memory",
    "collections": { "units": 1122, "genealogies": 1122, "events": 20000, ... },
    "indexes": { "lots": 412, "serials": 7854 }
  },
  "simulator": { "running": true, "speed": 1, "counters": { ... } },
  "mqtt": { "running": true, "tcpPort": 1883, "connectedClients": 1 }
}
```

Three probes, each answering a different question:

| Endpoint | Question | Use for |
|---|---|---|
| `/api/v1/live` | Is the process up? | Liveness probe |
| `/api/v1/ready` | Is the plant model loaded? Returns **503** until it is. | Readiness probe, load-balancer gate |
| `/api/v1/health` | Everything, with diagnostics. | Dashboards, debugging |

## Logs

Newline-delimited JSON in production, human-readable in development.

```bash
PC_LOG_LEVEL=debug npm start      # debug | info | warn | error | silent
```

```bash
# Errors only
docker logs production-core 2>&1 | jq -c 'select(.level=="error")'

# One subsystem
docker logs production-core 2>&1 | jq -c 'select(.scope=="production")'

# Trace one request end to end
docker logs production-core 2>&1 | jq -c 'select(.id=="3f2a91c4-...")'
```

Scopes: `server` `api` `http` `production` `quality` `operations` `trace`
`simulator` `mqtt` `node-red` `store` `seed` `context` `events`.

---

## Failure modes

### The plant is empty

**Symptom** — HMI shows no vehicles, `units: 0` in health.

**Check**

```bash
curl -s localhost:1880/api/v1/health | jq '.store.collections.units'
curl -s localhost:1880/api/v1/simulator | jq '{running, counters}'
```

**Causes**

| | |
|---|---|
| `PC_SEED_ON_BOOT=false` | Set it to `true`, or seed via the API |
| Snapshot restored from an empty file | `PC_STORE=file` restores whatever is on disk, including nothing. Delete `data/production-core.snapshot.json` and restart. |
| Simulator stopped | `POST /api/v1/simulator/start` |

The seeder is built so that it *cannot* produce an empty plant regardless of
when it boots — verified across all 96 half-hourly moments in a day. If it does,
that is a bug, and the first thing to capture is the boot time and
`PC_SEED_SHIFTS`.

### OEE reads 0%, or implausibly low

**Most likely: the shift just started.** Below 20 minutes elapsed the API
reports a rolling 8-hour window instead — check `window.rolling`:

```bash
curl -s localhost:1880/api/v1/kpi/dashboard | jq '.window'
```

If `rolling` is `false` and OEE is still near zero, look at what is stopped:

```bash
curl -s localhost:1880/api/v1/downtime/current | jq
curl -s localhost:1880/api/v1/stations | jq '[.items[] | select(.state!="RUNNING") | {stationId, state}]'
```

A cascade of `BLOCKED` stations upstream of one `DOWN` station is the line
backing up behind a stoppage — which is correct behaviour, not a bug. Clear the
stoppage:

```bash
curl -s localhost:1880/api/v1/andon?open=true | jq '.items[] | {id, stationId, callType}'
curl -s -X POST localhost:1880/api/v1/andon/AND-000118/resolve \
  -H 'x-api-key: …' -H 'content-type: application/json' \
  -d '{"resolution":"cleared manually","resolver":"ops"}'
```

### Vehicles are piling up at end of line

**Symptom** — `QUALITY` line WIP climbing, `EOL-*` stations `BLOCKED`.

```bash
curl -s "localhost:1880/api/v1/units?status=HOLD" | jq '.total'
curl -s "localhost:1880/api/v1/quality/defects?open=true" | jq '.total'
```

Vehicles held at `EOL-60` with open defects cannot be released, and the line
backs up behind them. The simulator's repair bay drains them automatically; if
they are accumulating, defects are being raised faster than they are being
dispositioned.

Clear one by hand:

```bash
curl -s -X POST localhost:1880/api/v1/quality/defects/DEF-000317/disposition \
  -H "$KEY" -H "$JSON" -d '{"disposition":"REWORK","operator":"ops"}'
curl -s -X POST localhost:1880/api/v1/quality/defects/DEF-000317/close -H "$KEY" -H "$JSON" -d '{}'
curl -s -X POST localhost:1880/api/v1/units/$VIN/release -H "$KEY" -H "$JSON" -d '{}'
curl -s -X POST localhost:1880/api/v1/units/$VIN/complete -H "$KEY" -H "$JSON" -d '{}'
```

Or lower the defect rate by turning fault injection off: `PC_SIM_FAULTS=false`.

### A station will not restart

**Symptom** — a station sits `STOPPED` or `MAINTENANCE` and the simulator never
brings it back; vehicles back up behind it.

That is the lockout working. Any control mode other than `AUTO` is held until a
person releases it, and the refusal says who holds it:

```bash
curl -s localhost:1880/api/v1/stations/BODY-20/control | jq '{state, control, blockedActions}'
```

`control.by` and `control.since` say who stopped it and when. Release it:

```bash
# An operator stop
curl -s -X POST localhost:1880/api/v1/stations/BODY-20/start -H "$KEY" -H "$JSON" -d '{"operator":"ops"}'

# Maintenance - sign the order off; start is refused until you do
curl -s -X POST localhost:1880/api/v1/stations/BODY-20/maintenance/complete \
  -H "$KEY" -H "$JSON" -d '{"technician":"ops","findings":"Released by operations"}'
```

If `start` is refused with *Resolve andon ANDON-… first*, the station is `DOWN`
on a line-stopping andon; resolve the andon and the station restarts with it.

With `PC_SIM_AUTO_RELEASE_MINUTES` above 0 (default 15), the simulator releases
operator stops and signs maintenance off on its own, in plant time. If that is
not happening, check the variable is not `0` and the simulator is running.

### Breakdowns are rising across the plant

**Symptom** — more `EQUIP_FAILURE` downtime shift on shift, availability falling.

Check the PM board. A station past its PM interval fails up to three times as
often:

```bash
curl -s "localhost:1880/api/v1/maintenance/due?dueOnly=true" | jq '.items[] | {stationId, usedPct, status}'
```

Service the overdue ones, most overdue first:

```bash
curl -s -X POST localhost:1880/api/v1/stations/PAINT-30/maintenance \
  -H "$KEY" -H "$JSON" -d '{"type":"PREVENTIVE","technician":"ops"}'
```

### MQTT will not connect

```bash
curl -s localhost:1880/api/v1/health | jq '.mqtt'
```

`tcpPort: null` means the port was already taken. **This is not fatal** — the
broker logs a warning and the application continues; the REST API, the HMI and
the flows all work without it.

```bash
ss -lptn 'sport = :1883'        # who has it
PC_MQTT_PORT=1884 npm start     # or move
```

If the port is bound but the flows show disconnected MQTT nodes, check the
broker config resolved correctly. The flows reference `${PC_MQTT_HOST}` and
`${PC_MQTT_PORT}`; the runtime writes the resolved values into the environment
before Node-RED reads the flow file. A blank `broker` field in the editor means
that did not happen.

### Node-RED flows will not start

```bash
curl -s localhost:1880/api/v1/health | jq '.nodeRed // "not reported"'
docker logs production-core 2>&1 | grep -i 'node-red'
```

| | |
|---|---|
| `Flow file not found` | Run `npm run build:flows` |
| Custom nodes missing from the palette | `nodesDir` must point at `nodes/`; check `PC_NODERED_ENABLED` is not `false` |
| `Production Core context is not initialised` | Node-RED was started standalone. It must boot through `src/index.js`, which registers the service context before loading any node. |
| Empty canvas | `flows.json` is malformed. `npm run verify:flows` and rebuild. |

### Memory climbing

It should not. Time-series collections are capped ring buffers:

```bash
curl -s localhost:1880/api/v1/health | jq '.store.collections | {events, telemetry}'
```

Both should plateau at their caps (20,000 and 10,000) and stay there.

Keyed collections *do* grow — `units`, `genealogies`, `subAssemblies` accumulate
as the simulator runs. On a long-lived instance, restart periodically or cap the
run with `PC_SIM_ENABLED=false` once you have enough history.

Lower the footprint with `PC_SEED_SHIFTS=1` (~14 MB instead of ~40 MB) and
`NODE_OPTIONS=--max-old-space-size=384`.

### API returns 401 on everything

Reads are open by default. If reads are 401, `PC_PROTECT_READS` is `true`.

For writes, send the key:

```bash
curl -H "x-api-key: $PC_API_KEY" …
```

### Swagger UI is blank

```bash
curl -s localhost:1880/openapi.json | jq '.openapi'
```

If the spec is served but the page is blank, `swagger-ui-dist` is missing — run
`npm install`. The raw document is still available regardless.

---

## Routine operations

### Reset the plant

```bash
# Ephemeral store: just restart
docker restart production-core

# File store: clear the snapshot first
rm -f data/production-core.snapshot.json && npm start
```

### Change simulation speed

```bash
curl -s -X POST localhost:1880/api/v1/simulator/speed \
  -H "$KEY" -H "$JSON" -d '{"speed":30}'    # fast-forward; figures are flagged as compressed
```

### Demonstrate a failure

```bash
# Break a station for five minutes
curl -s -X POST localhost:1880/api/v1/simulator/inject-fault \
  -H "$KEY" -H "$JSON" \
  -d '{"stationId":"PAINT-40","reasonCode":"ROBOT_FAULT","durationSeconds":300}'

# Put a critical defect on a specific vehicle
curl -s -X POST localhost:1880/api/v1/simulator/inject-defect \
  -H "$KEY" -H "$JSON" -d '{"vin":"'$VIN'","code":"TORQUE_LOW"}'
```

Then watch the andon board, the station grid and the line OEE react.

Or stop a station yourself and watch the line starve downstream and block
upstream of it — in the HMI, click any station on the **Stations** tab, or:

```bash
curl -s -X POST localhost:1880/api/v1/stations/CHAS-10/stop \
  -H "$KEY" -H "$JSON" -d '{"operator":"demo","reasonCode":"OPERATOR_STOP"}'
```

### Watch everything happening

```bash
curl -N localhost:1880/api/v1/events/stream
mosquitto_sub -h localhost -p 1883 -t 'northstar/#' -v
```

### Back up plant state

```bash
# File store writes a snapshot every PC_SNAPSHOT_INTERVAL_MS (default 15 s)
cp data/production-core.snapshot.json backup-$(date +%F).json
```

A snapshot is also flushed on graceful shutdown, which is why the container
uses `tini` — so `SIGTERM` actually reaches Node.

A corrupt snapshot never blocks a boot: it is logged, discarded, and the seeder
refills. That path is covered by a test.

---

## Shutdown

`SIGTERM` or `SIGINT` triggers an ordered drain:

```
simulator stopped  →  Node-RED flows stopped  →  HTTP closed
                   →  MQTT broker closed      →  final snapshot flushed
```

A stuck shutdown is force-exited after 10 seconds. The orchestrator would
`SIGKILL` anyway, and doing it deliberately at least runs the exit handlers.

---

## Performance reference

Measured on this codebase:

| | |
|---|---|
| Boot, warm filesystem | ~1.1 s |
| Boot, empty Node-RED user dir | ~1.5 s |
| Seed, 3 shifts (~1,000 vehicles) | ~2.5 s |
| Memory per seeded vehicle | ~36 KB |
| RSS, 3-shift seed + Node-RED | ~160 MB |
| Recall query, 527 affected of ~1,000 | ~256 ms |
| Simulator tick, 43 stations | ~3 ms |
| KPI dashboard, computed / cached | ~160 ms / < 1 ms |
| Full test suite | ~14 s on a local disk |
| Smoke test (boots the real stack) | ~60 s |

**Run it from a native Linux or macOS filesystem.** On an NTFS or exFAT mount
(an external drive, `/mnt/c` under WSL, a network share), Node's module
resolution is slow enough to matter: the test suite takes over 15 times longer
and boot several seconds more. The application hoists every `require()` out of
its hot paths so the plant itself is unaffected, but the tooling is not.

If a recall query is taking seconds rather than milliseconds, the lot index has
not been built. Restarting rebuilds it from the genealogy documents
(`repository.rebuildIndexes()`), which also runs automatically after a snapshot
restore.
