# RedLink / Render Bandwidth Incident Audit

Date: 2026-06-16 Europe/Moscow

For: Vlad, Sanya

## Short Answer

Render can be revived only after deploying `redlink-hub` version `0.5.0.9-bandwidth-guard` from `C:\dev\Redlink-hub`.

Do not revive the old deployment unchanged. The old hub could return growing public snapshots/queues, and Teleport clients had overlapping polling loops. Those two facts are enough to explain a free bandwidth burn, but exact per-endpoint attribution still requires Render logs/metrics from the incident window.

## What Is Proven In Code

1. The old public debug/signal surfaces were unsafe for bandwidth:
   - `/api/debug/signals` returned the full `signals` array.
   - `/api/debug/presence` returned full diagnostic snapshots.
   - `/api/redlink/poll` returned matching signal inbox without an explicit response byte cap.
   - `POST /api/redlink/signal` echoed the queued signal back to the sender.
   - JSON body limit was `8mb`.

2. The hub had cloud file relay routes in code:
   - `/api/redlink/file-transfer/start`
   - `/api/redlink/file-transfer/chunk`
   - `/api/redlink/file-transfer/complete`
   - `/api/redlink/file-transfer/download/:transferId`

   I did not find local proof that these were enabled on Render during the incident, but their presence is a serious risk surface. The current guard build hard-disables them.

3. Teleport/Companion had multiple RedLink polling paths:
   - Activity reverse DM poll loop around 1 second.
   - Foreground service poll loop around 1.3 seconds.
   - Heartbeat/presence loop also triggered reverse polling.
   - Extra diagnostic signal poll existed without explicit `limit`.

   This is not just theoretical. Multiple Android clients plus Redbox can repeatedly pull the same public board state. If responses grow, bandwidth growth becomes multiplicative.

4. Old Redbox snapshot folders still contain historical copies of unsafe `tools/redlink-render-hub/server.js`.

   These are archive/build artifacts, not the active Render hub, but they must not be used for deployment.

## What Was Fixed In RedLink Hub

File: `C:\dev\Redlink-hub\server.js`

Version: `0.5.0.9-bandwidth-guard`

Changes:

- RedLink is now explicitly a lightweight public board for presence/signaling/discovery.
- Request body limit default reduced from `8mb` to `64kb`.
- Cloud file relay is hard-disabled and returns `410 cloud_file_relay_disabled`.
- `GET /api/redlink/signal` returns `405`; signal creation is POST-only.
- Signal POST returns compact ack and no longer echoes full signal data.
- Signals have TTL, max count, max stored bytes, max data bytes, max poll count, and max response bytes.
- Poll responses include `retryAfterMs` and `X-RedLink-Retry-After-Ms`.
- Poll removes targeted signals only after they were actually returned in the bounded response.
- Presence/discovery/register responses are compact and capped.
- Heavy fields are stripped: payload/history/queue/base64/chunk/body/avatar/image/thumbnail/preview.
- Public safe endpoints were added:
  - `/api/board/status`
  - `/api/diagnostics/bandwidth`
- Detailed debug endpoints are no longer production mechanisms:
  - `/api/debug/presence`
  - `/api/debug/signals`
  - `/api/debug/bandwidth`

  They are dev/debug-only. This is not the main architecture; it is only a guardrail for detailed dumps.

- In-memory bandwidth counters now show top endpoints and hashed clients without storing payload.
- Basic per-IP rate limiting returns `429` with `Retry-After`.

## What Was Fixed In Android Teleport/Companion

Files:

- `C:\dev\redbox-companion\app\src\main\java\ru\redbox\companion\MainActivity.java`
- `C:\dev\redbox-companion\app\src\main\java\ru\redbox\companion\TeleportMessageService.java`
- `C:\dev\redbox-companion\app\src\main\java\ru\redbox\companion\core\FullRedboxCompatibleRouteStore.java`
- `C:\dev\redbox-companion\app\src\main\java\ru\redbox\companion\core\SignalReceivePollStore.java`

Changes:

- Removed duplicate reverse DM poll from heartbeat loop.
- Added state-based poll backoff:
  - empty/default poll sleeps about 5-6 seconds.
  - successful message poll remains faster.
  - errors/http failures sleep about 15 seconds.
- Added explicit `limit=20` to RedLink poll calls.
- Diagnostic poll mode no longer asks for an unbounded raw dump.

## Most Likely Bandwidth Cause

The strongest code-level culprit is this combination:

1. Public endpoints could return growing arrays/snapshots.
2. Clients had overlapping polling loops.
3. There were no strict response byte caps and weak TTL/queue discipline.
4. Old debug endpoints were easy to accidentally use as production data routes.

That combination can burn gigabytes without file payloads. If any client or debug page repeatedly hit `/api/debug/signals` or a growing `/api/presence`, the response size would increase over time and every polling client would multiply it.

## What Is Still Not Proven

I cannot honestly claim exact attribution of the 5 GB without Render-side data:

- per-endpoint request counts;
- per-endpoint egress bytes;
- client/IP/user-agent frequency;
- whether `/api/debug/signals` was actually hit during the incident;
- whether file relay env was ever enabled on Render;
- whether an old Redbox/Teleport build was still polling at the old high rate.

After redeploy, the new `/api/diagnostics/bandwidth` and `/api/board/status` endpoints should give us immediate live attribution.

## Safe Revive Plan

1. Deploy only `C:\dev\Redlink-hub` at version `0.5.0.9-bandwidth-guard`.
2. Ensure Render is not running any old copied hub from `C:\dev\redbox\...\tools\redlink-render-hub`.
3. Keep cloud relay disabled.
4. Start with one Redbox and one Android.
5. Watch:
   - `/api/board/status`
   - `/api/diagnostics/bandwidth`
   - Render bandwidth graph
6. Add second Android only after 10-15 minutes of stable low egress.
7. If response bytes climb, stop clients first, then inspect top endpoints/top hashed clients.

## Current Validation

- `node --check C:\dev\Redlink-hub\server.js` passed.
- Local smoke test passed:
  - `/api/health` -> 200
  - `/api/board/status` -> 200
  - `/api/diagnostics/bandwidth` -> 200
  - production `/api/debug/signals` -> 404
  - `GET /api/redlink/signal` -> 405
  - cloud file relay -> 410
  - `POST /api/redlink/signal` returns compact ack
  - `/api/redlink/poll` returns bounded response with retry hint
- Android build passed:
  - `.\gradlew.bat --no-problems-report :app:assembleDebug`

## Recommendation To Sanya

Do not treat the old rough 5 GB calculation as proof. The proven part is architectural/code-level: RedLink allowed growing responses and clients polled too aggressively from multiple loops. The exact Render bill source must be confirmed by live counters after guarded redeploy, or by Render logs if available.

After `0.5.0.9-bandwidth-guard`, it is reasonable to revive Render for a controlled test. It is not reasonable to revive the old deployment or old clients and “just watch”.
