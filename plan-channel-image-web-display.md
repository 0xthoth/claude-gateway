# Plan — show channel-generated images in the web transcript

> Repo: **claude-gateway**. When a Telegram/Discord agent generates + delivers an
> image (via the reply tool's `files`), it shows in the channel but the web view of
> that session shows nothing. Make the web render it too.

## Root cause (verified)
The web renders an assistant image from the message's `mediaFiles` field → it builds
`/api/v1/agents/<id>/media/<relPath>` → the gateway media route serves the file.
- **API sessions**: generated images ARE recorded in `mediaFiles` (the `api_reply`
  tool buffers files via `runner.addApiAttachments` → persisted as `mediaFiles`), so
  the web shows them.
- **Channel (Telegram/Discord) sessions**: the reply tool call is tracked and the
  assistant text is persisted (`runner.ts` ~line 907, `historyDb.insertMessage({...,
  role:'assistant', content: replyText })`), but the reply's `input.files` (the image
  paths) are **NOT captured** → the persisted message has no `mediaFiles` → the web
  transcript is blank.

Everything downstream already works — proven:
- File exists: `media/session-<id>/image_...png` (2 MB PNG).
- Media route serves it: `GET /api/v1/agents/getpod/media/session-<id>/image_...png` → **200 image/png**.
- Web `use-messages.ts` normalises `media/...` → the media URL and renders it.
So the ONLY gap is the channel turn not recording `mediaFiles`.

## The fix (one spot, gateway `src/agent/runner.ts`)
At the reply-tool-call tracking block (~line 900-915, inside the channel stream loop
where `block.type === 'tool_use' && block.name === replyToolName`):

1. Extract the attached files from the reply tool call:
   `const replyFiles = Array.isArray(block.input?.['files']) ? block.input['files'] as string[] : [];`
2. Convert each ABSOLUTE path under the agent media root to a relative `media/<rel>`
   path (reuse the exact logic in `popApiAttachments`, runner.ts ~2310):
   ```ts
   const mediaRoot = path.join(this.agentsBaseDir, this.agentConfig.id, 'media') + path.sep;
   const replyMedia = replyFiles
     .filter((p) => typeof p === 'string' && p.startsWith(mediaRoot) && fs.existsSync(p))
     .map((p) => 'media/' + p.slice(mediaRoot.length).replace(/\\/g, '/'));
   ```
3. Pass them to the assistant `insertMessage` call already there:
   ```ts
   this.historyDb.insertMessage({
     chatId: `${channelSrc}-${mapKey}`,
     sessionId: actualSessionId,
     source: channelSrc as HistorySource,
     role: 'assistant',
     content: replyText,
     mediaFiles: replyMedia.length ? replyMedia : undefined,   // ← ADD THIS
     ts: ...,
   });
   ```
   (`insertMessage` already supports `mediaFiles` — the API user/assistant persists use it.)

That is the whole change. Optional refinements:
- Persist the assistant reply even when `replyText` is empty but `files` are present
  (an image-only reply). Currently persistence is gated on `if (replyText)`; broaden to
  `if (replyText || replyMedia.length)` so an image-only send still shows in the web.

## What does NOT change
- The media route (`router.ts:2350`) — already serves `session-<id>/...` paths.
- The web (`use-messages.ts`, attachment rendering) — already renders `mediaFiles`.
- File storage — the image is already saved under `media/session-<id>/`.
- The channel delivery (Telegram reply upload) — untouched.

## Security / correctness notes
- Only files UNDER the agent media root are recorded (the `startsWith(mediaRoot)`
  filter) — never arbitrary abs paths the tool call might contain.
- Only existing files (`fs.existsSync`) — avoids dangling → media route 404 → "Unavailable".
- Same media-lifetime guarantees as API images (retention sweep / clearChatMedia already
  cover `media/<channel>-<chatId>/` paths).

## Tests
- **Unit** (`tests/unit/...`): given a reply tool_use block with `input.files` of an
  abs path under the media root, the derived `mediaFiles` = `['media/<rel>']`; a path
  OUTSIDE the media root or a non-existent file is dropped. (Extract the abs→rel
  helper so it's testable without the full stream loop.)
- **Manual e2e**: Telegram "draw a cat" → image delivered to Telegram AND, opening the
  same session at `localhost:3001/chat/<id>`, the image renders inline (via
  `/api/v1/agents/<id>/media/session-<id>/...`). Confirm an image-only reply (no text)
  also shows if the empty-text refinement is applied.

## Scope / branch
Gateway only, `src/agent/runner.ts` (+ a small helper + unit test). No getpod/API/web
change. Fits on `feature/184-image-gen` or a small `fix/channel-image-web-display` branch.
