# The 24 h soak (R-AM)

Ken owns the clock. Nothing in this directory starts one.

Per R-AM the soak does **not** run on the Windows dev box. It runs on Hetzner as
a staging stack, off the prod network, built from **this tree** — branch
`e2e/soak-rig` off `392e490`, the tree D1 ships. That is not a preference: the
Hetzner host has no GitHub access, so the image is built from the checkout that
is copied to it, and a rig that only exists on another branch cannot be built
there at all. The files here are the rig; the 24 h window begins when you run it.

| file | what it is |
|---|---|
| `docker-compose.soak.yml` | the stack: `soak-db`, `soak-migrate`, `soak-relay`, `soak-runner` |
| `Dockerfile.soak` | one image for relay and runner (same node, same `lib/e2e`) |
| `Dockerfile.soak.dockerignore` | keeps the host's `node_modules` out of the build context |
| `soak-runner.mjs` | pairs one ON and one OFF pair via Connect+Accept, holds them, writes heartbeat + trace |
| `verify-soak.mjs` | gives the verdict on a finished run |

`soak-runner.mjs` and `verify-soak.mjs` are modules with an entry-point guard:
importing either does nothing at all, and `tests/soak-rig.test.mjs` asserts that
plus the verifier's own gap / short-window / two-file refusals.

---

## Start it

```bash
cd <repo>/soak
export SOAK_SHA=$(git rev-parse --short HEAD)          # the e2e/soak-rig sha
export SOAK_JWT_SECRET=$(openssl rand -base64 48)      # MUST be >= 32 chars
docker compose -f docker-compose.soak.yml up -d --build
docker compose -f docker-compose.soak.yml logs -f soak-runner   # confirm it started
```

The runner prints its two evidence paths on the first line. Record the start UTC
in `e2e/CHECKPOINTS.md` at that moment — that is the clock.

`SOAK_JWT_SECRET` is required and the stack refuses to boot without it. It is
passed to **both** the relay and the runner, because the runner signs the
browser tickets the relay verifies; see "the 4401 trap" below.

`soak-migrate` runs `prisma db push` against the scratch Postgres once and
exits; the relay waits for it. The scratch database starts empty, and without
that step the relay's entitlement chokepoint queries a `User` table that does
not exist.

### What is ON in this stack, and only in this stack

`E2E_PAIRING_ENABLED: "1"` is set on `soak-relay`. At `392e490` the predicate is
`process.env.E2E_PAIRING_ENABLED === '1'` (server.js) — the string `1` and
nothing else enables encrypted pairing; unset or any other value is OFF. That
variable is set in this compose file's container environment only. Nothing here
touches prod's environment, prod's database or prod's network, and prod stays
OFF until D1 flips it.

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
record that in CHECKPOINTS and start again. Exit 2 is a caller error (no file, or
more than one heartbeat file) and is not a graded window either way. It checks:

- the heartbeat parses, and has a start and an end marker
- **no gap over 10 min** — rule 8's invalidation threshold
- the window spans at least 24 h, and the beat count matches the span
  (so a file cannot pass by being truncated at both ends)
- both pairs were open at **every** heartbeat — and *open* now means **ACTIVE**
  (see "The lobby trap" below), not merely connected
- **no heartbeat reports a pair that is not ACTIVE**, and every heartbeat shows a
  non-zero `fwdOn` / `fwdOff` forward delta
- no pairing was rejected or terminated during the window
- **zero** unexpected closes (anything but 1000 / 1001 / 4010)
- one build sha for the whole window
- RSS grew no more than 25% from the first third to the last — the soak hunts a
  slow leak, so the threshold is on the trend, not on any single peak
- the runner ended because its window completed, not because it was killed
- traffic actually flowed — judged on **`framesRecv*`, never `framesSent*`**: both
  pairs must have received, the relay must have returned **>= 90%** of what was
  sent, and no tick may have been skipped for want of an active pair

A heartbeat file written by the pre-SOAK-RIG-2 runner has no `onActive` /
`fwdOn` fields and therefore **fails**. That is deliberate: it is evidence from a
rig that could not tell the difference.

`verify-soak.mjs` takes **one** heartbeat file and refuses a second. Two 12 h
windows are not a 24 h soak, and the easiest way to claim otherwise by accident
is a tool that accepts a list. NEW-MA-3: never stitch windows.

## Rehearse it first

The rig was rehearsed end-to-end against the real relay on the dev box under P6
(90 s, cadence compressed): `12 passed, 0 failed — VALID`. **That rehearsal was
on the P6 tree and is not evidence about this one** — the container stack on this
branch has not been run anywhere yet, and Ken's `up -d --build` is its first
execution. To rehearse the runner alone against a local relay:

```bash
SOAK_HOURS=0.025 SOAK_HEARTBEAT_MS=5000 SOAK_TRACE_MS=15000 SOAK_TRAFFIC_MS=3000 \
  node soak/soak-runner.mjs
```

That needs a `DATABASE_URL` and a `JWT_SECRET` matching the relay you point it
at. `verify-soak.mjs` still grades against the real 10 min / 24 h thresholds, so
a rehearsal can never be mistaken for a run — pass `--hours` to grade a
rehearsal on its own terms.

## The 4401 trap — read this before debugging a quiet soak

The first rehearsal of this runner produced **178 socket closes, 89 reconnects
per role and zero frames in 90 seconds**, and the heartbeat file looked
superficially fine. Every close was `4401 invalid_token`.

The relay authenticates at the WS **upgrade**, before any frame exists, and then
runs the entitlement gate — which is the paywall and is deliberately
fail-closed. So a socket opened as `ws://host/relay?role=phone` with no
credentials is rejected immediately, and a runner that counts `open` events will
report healthy sockets for 24 h while soaking nothing at all.

Three specific edges, all of which have cost real time:

- **`JWT_SECRET` under 32 characters makes the relay refuse ALL ticket auth**,
  and it says so only on its own stdout. The failed rehearsal's secret was 17
  characters.
- **The runner's `JWT_SECRET` must be the relay's.** A runner with no
  `JWT_SECRET` mints its own, signs valid-looking tickets with a secret the
  relay has never seen, and loses exactly the browser half of both pairs to
  4401 while the phone sockets stay up — a soak that looks half alive for a day.
  The compose file passes `SOAK_JWT_SECRET` to both services for this reason,
  and the runner logs a warning if it ever has to fall back.
- The relay `await`s the token lookup and entitlement evaluation *before*
  attaching its `message` handler, so **a frame sent on `open` is dropped
  silently**. Wait for the relay's own first frame before sending.

`scripts/lib/relay-auth.mjs` encodes all of this — `mintSecret()` cannot produce
a short secret, `seedEntitledUser()` seeds a user the gate admits (via the
`isAdmin` short-circuit, entitlement rule (1)), and `openAuthed()` rejects with
the close code instead of resolving on `open`. Any harness driving real sockets
should use it rather than rediscovering 4401.

The two pairs get **separate** users on purpose: the relay's room key is the
phoneToken, so one user would put the ON and OFF pairs in the same room, where
the single-active-session sweep kicks one of them. A 24 h run of two pairs
fighting each other reads as relay instability that is entirely the harness's
own doing.

## The lobby trap — the defect that cost the first window

The relay is **Connect+Accept** (`server.js` `startRelay()` docblock, dispatch
#32). Every socket that authenticates lands in `room.lobby`. The data plane
forwards **only** between `room.active.browser` and `room.active.phone`, and a
room gets an active pair only through an explicit handshake:

```
browser --BROWSER_REQUEST_PAIRING:{ua,ip}--> relay
relay   --PAIRING_REQUEST:{pairingId,...}--> phone      (30 s TTL)
phone   --ACCEPT_PAIRING:{pairingId}------> relay
relay   --PAIRING_ACTIVE:{...}------------> BOTH sides
```

The first execution of this rig (Hetzner, 2026-09-20T02:32Z) opened all four
sockets, authenticated every one of them, logged **zero 4401** — and soaked
nothing for the entire window. It never sent `BROWSER_REQUEST_PAIRING`. Both
rooms sat in the lobby, the relay logged `Dropping lobby-phone frame …
type=SMS_RECEIVED` on every tick, and the sealed passthrough the ON pair exists
to exercise was never touched. The verifier graded traffic on `framesSent` — a
counter the runner increments about frames the relay was throwing away — so it
would have called that window **VALID**.

Three things changed because of it:

1. **The runner performs the handshake**, and re-performs it on **every
   reconnect**. It does *not* lean on the relay's resume claim: the claim only
   re-forms a pair inside `RESUME_WINDOW_MS` with the peer still active, and
   outside that window the relay sends `PAIRING_TERMINATED` and both sockets go
   back to the lobby. A recovery that depended on the claim would fall back into
   lobby-soaking the first time a reconnect landed outside it. Re-arming
   unconditionally is safe because the relay answers a redundant request with
   `PAIRING_REJECTED:{reason:'already_active'}`.
2. **A pair is "open" only once BOTH of its sockets have seen `PAIRING_ACTIVE`.**
   `onOpen` / `offOpen` in the heartbeat now mean that. `onActive` / `offActive`
   are also written separately, so a reader can tell "socket died" apart from
   "socket fine, pair fell back to the lobby".
3. **The verdict is receive-based.** `framesRecv*` counts frames on the
   **browser** socket — frames the relay actually forwarded. `fwdOn` / `fwdOff`
   in each heartbeat are the per-beat *deltas*, so a window that stops forwarding
   halfway names the beat instead of hiding inside a cumulative total.

The runner sends **no `e2e` block** in `BROWSER_REQUEST_PAIRING`. Mode ON here
means a sealed-*shaped* data body, not a real encrypted pairing; a `mode=1` block
would be refused outright whenever `E2E_PAIRING_ENABLED != '1'` and the soak
would be measuring the kill switch instead of the forward path.

### How this is proven, and not merely claimed

`tests/soak-handshake.test.mjs` boots the **shipped `server.js`** on an ephemeral
port (`tests/lib/relay-boot.cjs` stubs only `next`), runs the **real**
`soak/soak-runner.mjs` against it for a 15 s rehearsal, and asserts the heartbeat
says ACTIVE with non-zero forward deltas. It also carries the plant: the same
client with the handshake removed, which must forward **nothing** and must be
graded INVALID. Every other relay suite in this repo *mirrors* server.js's state
machine by hand — a mirror written by the same author as the client will agree
with it by construction, which is exactly how this defect shipped.

## Stop it

```bash
docker compose -f docker-compose.soak.yml down          # keeps the volumes
docker compose -f docker-compose.soak.yml down -v       # discards the evidence too
```

Copy the evidence out **before** `down -v`.
