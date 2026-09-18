# P6 (f) — the 24 h soak

Ken owns the clock. Nothing in this directory starts one.

Per R-AM the soak does **not** run on the Windows dev box. It runs on Hetzner as
a staging stack, off the prod network, built from the **post-D1-PREP** tree. The
files here are the rig; the 24 h window begins when you run it.

| file | what it is |
|---|---|
| `docker-compose.soak.yml` | the stack: `soak-db`, `soak-relay`, `soak-runner` |
| `Dockerfile.soak` | one image for relay and runner (same node, same `lib/e2e`) |
| `soak-runner.mjs` | holds one ON pair and one OFF pair; writes heartbeat + trace |
| `verify-soak.mjs` | gives the verdict on a finished run |

---

## Start it

```bash
cd <repo>/soak
export SOAK_SHA=$(git rev-parse --short HEAD)          # the post-D1-PREP sha
export SOAK_JWT_SECRET=$(openssl rand -base64 48)      # MUST be >= 32 chars
docker compose -f docker-compose.soak.yml up -d --build
docker compose -f docker-compose.soak.yml logs -f soak-runner   # confirm it started
```

The runner prints its two evidence paths on the first line. Record the start UTC
in `e2e/CHECKPOINTS.md` at that moment — that is the clock.

`SOAK_JWT_SECRET` is required and the stack refuses to boot without it. That is
deliberate: see "the 4401 trap" below.

## Where the evidence lands

Everything is on the `soak_evidence` volume, mounted at `/evidence`:

| path | what |
|---|---|
| `/evidence/<start-UTC>.jsonl` | **heartbeat**, one line per 5 min (RESUME-PROTOCOL rule 8) |
| `/evidence/trace-<sha>-<start-UTC>.jsonl` | **trace**, one line per hour + start/end |
| `/evidence/soak-<sha>.log` | full relay stdout for the window (Security N-2) |

Copy them out when the window ends:

```bash
docker cp cc-e2e-soak-runner:/evidence ./soak-evidence-$SOAK_SHA
```

`docker logs --since 24h` is the **secondary** source for the canary grep. The
file is primary, because the daemon's rotation policy can discard the window you
are trying to grep and a rotated-away log returns 0 for the wrong reason.

## Read the verdict

```bash
node soak/verify-soak.mjs <heartbeat.jsonl> <trace.jsonl>
```

Exit 0 = `VALID 24 h soak window`. Exit 1 = `INVALID` and **the clock restarts** —
record that in CHECKPOINTS and start again. It checks:

- the heartbeat parses, and has a start and an end marker
- **no gap over 10 min** — rule 8's invalidation threshold
- the window spans at least 24 h, and the beat count matches the span
  (so a file cannot pass by being truncated at both ends)
- both pairs were open at **every** heartbeat
- **zero** unexpected closes (anything but 1000 / 1001 / 4010)
- one build sha for the whole window
- RSS grew no more than 25% from the first third to the last — the soak hunts a
  slow leak, so the threshold is on the trend, not on any single peak
- the runner ended because its window completed, not because it was killed
- traffic actually flowed

`verify-soak.mjs` takes **one** heartbeat file and refuses a second. Two 12 h
windows are not a 24 h soak, and the easiest way to claim otherwise by accident
is a tool that accepts a list. NEW-MA-3: never stitch windows.

## Rehearse it first

The rig has already been rehearsed end-to-end against the real relay on the dev
box (90 s, cadence compressed): `12 passed, 0 failed — VALID`. To repeat it:

```bash
SOAK_HOURS=0.025 SOAK_HEARTBEAT_MS=5000 SOAK_TRACE_MS=15000 SOAK_TRAFFIC_MS=3000 \
  node soak/soak-runner.mjs
```

`verify-soak.mjs` still grades against the real 10 min / 24 h thresholds, so a
rehearsal can never be mistaken for a run — pass `--hours` to grade a rehearsal
on its own terms.

## The 4401 trap — read this before debugging a quiet soak

The first rehearsal of this runner produced **178 socket closes, 89 reconnects
per role and zero frames in 90 seconds**, and the heartbeat file looked
superficially fine. Every close was `4401 invalid_token`.

The relay authenticates at the WS **upgrade**, before any frame exists, and then
runs the entitlement gate — which is the paywall and is deliberately
fail-closed. So a socket opened as `ws://host/relay?role=phone` with no
credentials is rejected immediately, and a runner that counts `open` events will
report healthy sockets for 24 h while soaking nothing at all.

Two specific edges, both of which cost real time:

- **`JWT_SECRET` under 32 characters makes the relay refuse ALL ticket auth**,
  and it says so only on its own stdout. The failed rehearsal's secret was 17
  characters.
- The relay `await`s the token lookup and entitlement evaluation *before*
  attaching its `message` handler, so **a frame sent on `open` is dropped
  silently**. Wait for the relay's own first frame before sending.

`scripts/lib/relay-auth.mjs` encodes all of this — `mintSecret()` cannot produce
a short secret, `seedEntitledUser()` seeds a user the gate admits, and
`openAuthed()` rejects with the close code instead of resolving on `open`. Any
harness driving real sockets should use it rather than rediscovering 4401.

The two pairs get **separate** users on purpose: the relay's room key is the
phoneToken, so one user would put the ON and OFF pairs in the same room, where
the single-active-session sweep kicks one of them. A 24 h run of two pairs
fighting each other reads as relay instability that is entirely the harness's
own doing.

## Stop it

```bash
docker compose -f docker-compose.soak.yml down          # keeps the volumes
docker compose -f docker-compose.soak.yml down -v       # discards the evidence too
```

Copy the evidence out **before** `down -v`.
