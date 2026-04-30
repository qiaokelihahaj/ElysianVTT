# Frontend Review Report (2026-04-30)

## Scope
- Reviewed: `packages/frontend/src` core runtime path (App, network, store, canvas renderer, HUD/timeline/entity UI).
- Verification run:
	- `pnpm --filter @hard-vtt/frontend build` (pass)
	- Diagnostics (`get_errors`) for `packages/frontend` (no TS/ESLint problems reported in current editor diagnostics)

## Findings (Ordered by Severity)

### 1) High - Scene resync does not clear local predictive state, causing stale timeline and ghost movement
- Evidence:
	- Scene sync replaces `tick/entities/selectedEntityId` only: `setInitialScene(...)` in [packages/frontend/src/store/gameStore.ts](packages/frontend/src/store/gameStore.ts#L55)
	- Scene sync callsite: [packages/frontend/src/App.tsx](packages/frontend/src/App.tsx#L29)
- Why this is risky:
	- Client-side prediction state (`movementTargets`) and timeline cache (`scheduledActions`) can survive a full scene sync.
	- After reconnect/resync, UI may display outdated action bars and continue interpolating toward obsolete local targets.
- Suggested fix:
	- In `setInitialScene`, also reset `uiState`, `movementTargets`, and `scheduledActions`.
	- Consider a dedicated `hardResetFromSceneSync` action to ensure all derived/transient client state is rebuilt from authoritative data.

### 2) Medium - Scene selection is hard-coded to `room_1`
- Evidence:
	- Constant definition: [packages/frontend/src/App.tsx](packages/frontend/src/App.tsx#L7)
	- Immediate join call: [packages/frontend/src/App.tsx](packages/frontend/src/App.tsx#L12)
- Why this is risky:
	- Blocks multi-scene usage and test environments with different room ids.
	- Makes deployment/configuration brittle and couples client runtime to a fixed server-side fixture.
Suggested fix:
	- Source scene id from route/query string, user selection, or env configuration with fallback handling.

### 3) Low - Dynamic import strategy is ineffective and adds complexity in hot path
- Evidence:
	- Dynamic import in visual FX handler: [packages/frontend/src/App.tsx](packages/frontend/src/App.tsx#L23)
	- Same module is statically imported elsewhere: [packages/frontend/src/canvas/GameCanvas.tsx](packages/frontend/src/canvas/GameCanvas.tsx#L2)
	- Build warning observed:
		- `[INEFFECTIVE_DYNAMIC_IMPORT] ... dynamically imported ... but also statically imported ... dynamic import will not move module into another chunk`
- Why this is risky:
	- No bundle split benefit, but introduces per-event Promise scheduling and mental overhead.
Suggested fix:
	- Use one strategy only: either static singleton access everywhere, or isolate all usage behind a true lazy boundary.

### 4) Low - Visual FX timeouts are not tracked/cleared on renderer destroy
- Evidence:
	- Timeout creation points: [packages/frontend/src/canvas/RendererManager.ts](packages/frontend/src/canvas/RendererManager.ts#L357), [packages/frontend/src/canvas/RendererManager.ts](packages/frontend/src/canvas/RendererManager.ts#L390)
	- Destroy path does not cancel pending timers: [packages/frontend/src/canvas/RendererManager.ts](packages/frontend/src/canvas/RendererManager.ts#L443)
- Why this is risky:
	- During rapid mount/unmount (dev strict mode, reconnect, HMR), delayed callbacks can run against torn-down containers.
	- May create noisy warnings or inconsistent cleanup behavior.
- Suggested fix:
	- Store timeout handles and clear them in `destroy()`.

## Open Questions
1. Is `VisualEventPayload.targetCoords` guaranteed to be world units or pixel units?
2. Should scene sync semantics be "full authoritative snapshot" (clear all transient state) or "partial merge"?

## Residual Risk and Test Gaps
- No dedicated frontend test currently validates scene resync state reset behavior.
- No renderer test currently asserts coordinate unit consistency for `UI_FLOATING_TEXT` events.
- No lifecycle test currently validates timer cleanup during renderer destroy/remount.

## Recommended Next Tests
1. Add store test: `setInitialScene` clears transient client state.
2. Add protocol test: clarify whether `UI_FLOATING_TEXT.targetCoords` is world units or pixel units, then assert the renderer follows that contract.
3. Add integration test: remount renderer while FX events are active; assert no post-destroy callback side effects.
