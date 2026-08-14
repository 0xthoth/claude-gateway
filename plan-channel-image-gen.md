# Plan — enable image generation in channels (Telegram/Discord/Line)

> Repo: **claude-gateway**. Goal: when a channel user asks for an image, the agent
> USES the `generate_image` tool (which is already available) instead of hallucinating
> "install an app / set up API keys".

## Root cause (verified)
- The `generate_image` tool IS available in channel sessions: `ImageModule.toolVisibility = 'all-configured'` (always visible) + `isEnabled()` true (the channel session's `mcp-config.json` has `ANTHROPIC_BASE_URL=http://host.docker.internal:8091`). Confirmed on the getpod telegram session `e736697a` (`GATEWAY_ORIGIN_CHANNEL=telegram`, base URL present).
- BUT the agent only receives an explicit "call generate_image" DIRECTIVE on the WEB path: `router.ts` passes `image_params` → `AgentRunner.buildImageParamsNote` (`runner.ts:689/706`) injects a per-message note. Channels have no composer → `imageParams` undefined → note = `''`.
- With no directive AND the pod's `CLAUDE.md` advertising `/apps:install-app`, haiku mis-routes: it tells the user to install an image app instead of using the built-in tool.
- Telegram/Discord DELIVERY already works natively: the `reply` tool accepts `files: ["/abs/path.png"]` (no public URL needed — unlike the removed LINE path).

## Fix — add a standing, authoritative channel instruction (stronger than a tool description)
The tool description (`imageToolDefs`, module.ts:538) is already good but not authoritative
enough for a small model against the apps-install pull. The fix is a **system-level channel
instruction** that only appears when the image tool is actually enabled.

### Change 1 — `mcp/server.ts` (primary)
Currently the MCP `Server` is constructed with a hardcoded `instructions: [ ...telegram lines... ].join('\n')`. Refactor to make it conditional + testable:
1. Compute a flag from the already-built tool list:
   ```ts
   const imageEnabled = visibleTools.some((t) => t.name === 'generate_image');
   ```
2. Extract the instruction array into a pure helper for testability:
   ```ts
   // instructions.ts (new) or top of server.ts
   export function buildChannelInstructions(originChannel: string, imageEnabled: boolean): string {
     const lines = [ /* existing channel lines (unchanged) */ ];
     if (imageEnabled) {
       lines.push('', IMAGE_INSTRUCTION);
     }
     return lines.join('\n');
   }
   ```
3. `IMAGE_INSTRUCTION` (the new nudge — channel-neutral, honest, counters the hallucination):
   > "IMAGE GENERATION IS BUILT IN — you can create images yourself; no app install or API-key setup is needed.
   > • When the user asks to create / draw / make / design / edit an image, picture, logo, or art, call generate_image with action=\"list\" to see the models.
   > • If the user named a model / quality / style, honor it. Otherwise pick a USABLE model (byok_available or pool_eligible) — prefer a BYOK model, then the lowest image_cost; use quality \"medium\" if the model offers it. Then action=\"generate\" and deliver the returned file with your reply tool (files: [\"/abs/path.png\"]). Briefly mention which model you used.
   > • If action=\"list\" returns NO usable model (none has byok_available or pool_eligible), tell the user PLAINLY that image generation isn't set up with a usable model yet and they need to connect an image-provider key (BYOK). Do NOT invent app-install / MCP-setup steps, and do NOT pretend an image was created.
   > • NEVER tell the user to install an app or set up an MCP server for images."

   Design decisions locked with the owner: behavior **B** (auto-pick a sensible default + briefly say which model; honor an explicit user choice; don't ask permission for a simple request). Default pick = **BYOK-first, then cheapest `image_cost`** (data-driven; no curated "best/popular" list — that field doesn't exist). No-usable-model case is handled **straightforwardly/honestly** (option A) — NOT by faking success or by hallucinating an install flow.
4. Pass `instructions: buildChannelInstructions(ORIGIN_CHANNEL, imageEnabled)` to the `Server`.

### Change 2 — `mcp/tools/image/module.ts` (minor, belt-and-braces)
Prepend one clause to the `generate_image` description so the tool self-advertises intent:
> "Use this WHENEVER the user asks to create/draw/make/edit an image — it is built in, no app install needed. "
(Keep the rest of the description as-is.)

### No change needed
- Web path (`buildImageParamsNote`) — already works; leave it.
- Delivery — Telegram/Discord `reply files:[...]` already works.

## Data prerequisite (config — DEFERRED by owner)
Even with the nudge, `action="generate"` only succeeds if the catalog has a **usable** image
model (byok_available OR pool_eligible) for the user. Currently local has `openai/dall-e-3`
with no supply → `no_supply`, i.e. **no default usable model exists today**. Making one usable
is a separate CONFIG decision (managed pool supply vs BYOK-only) that the owner is **deferring** —
this code change does NOT set up a default. Until a usable model is configured, the honest
no-usable-model branch of IMAGE_INSTRUCTION is what channel users will hit (by design, straightforward).

## Tests
- **Unit** (`tests/unit/channel-instructions.test.ts`, new): `buildChannelInstructions(ch, true)` includes the IMAGE_INSTRUCTION (and the "NEVER tell the user to install an app" clause); `(ch, false)` excludes it; existing channel lines are unchanged in both.
- **Build**: `npm run build` (tsc) green.
- **Manual e2e** (needs a usable model): send Telegram "วาดรูปแมวให้หน่อย" → agent calls generate_image (action=list → generate) → replies with the image file → image shows in Telegram. Confirm it does NOT reply "install an app".

## Rollback
Single-file revert of `mcp/server.ts` (+ the new instructions helper/test) restores prior behavior. No runtime/data change.

## Branch / scope
Gateway only. Fits on `feature/184-image-gen` (or a small `feat/channel-image-nudge` branch). No getpod/API change.
