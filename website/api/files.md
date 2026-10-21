# Files API {#files-api}

List, create and delete folders under one pod-wide root, `~/projects` by default. The gateway does not serve file
contents: it has no route that lists a folder's files or returns a file. View files in code-server. The read-only
[Git API](/api/git) reports the git status of folders under the same root.

Every path in a request is **relative to the root**. A path is a list of folder names joined by `/`, such as
`site` or `site/web`. The empty path, or no `path` at all, names the root. Every response that names a folder also
carries `abs`, its absolute path on the pod, so a client never has to join paths itself.

**Auth.** The folders belong to the pod, not to an agent, so any valid API key can list them. Creating and deleting a
folder change the pod and need an admin API key (`admin: true`). Any other key, a pod-wide write key included, gets
`403 forbidden_key` on those two routes.

**Feature detection.** `GET /api/v1/capabilities` lists `"files": ["list", "create", "delete"]` and
`"git": ["status", "summary"]` for an admin key. A key that is not an admin key gets `"files": ["list"]`. Show a
listing only when `files` includes `"list"`, folder create only when it includes `"create"`, and the Delete action
only when it includes `"delete"`. When the files API is off, `files`, `git` and `projects` are empty and
`filesUnavailable` is `"disabled"`. See [Capabilities](/api/system#get-apiv1capabilities).

**On by default.** The routes are on for every install, with the root `~/projects`, and need no configuration. To
switch them off, set `gateway.files.enabled` to `false` and restart. Only a boolean counts: the string `"false"`, `0`
or `null` is ignored with a warning in `gateway.log`, and the files API keeps its default, which is on:

```json
{ "gateway": { "files": { "enabled": false } } }
```

**Security model.** An admin key can do everything, for every agent. Any other key reaches the agents it lists, can
write only when it has `write: true`, and can list every folder under the root and read its git status. The gateway
does not serve file contents to any key. Every listing carries the host path of the root as `root`, which usually
includes the home directory. These checks are not a filesystem boundary. Agents run with
`--dangerously-skip-permissions`, and a chat bound to a folder runs its agent inside it, so any key that can send that
agent a message can ask it to read or change any file the gateway's user can reach. Sending a message does not need
`write`, so this includes a read-only key. Treat an admin key as full access to the pod, and treat a key that can reach
an agent as able to change every folder under the root.

## Configuration {#configuration}

```json
{
  "gateway": {
    "files": { "root": "/srv/projects", "trusted": ["site"], "enabled": true }
  }
}
```

| Key | Meaning |
|-----|---------|
| `root` | An absolute path or a path starting with `~/`. Default `~/projects`. |
| `trusted` | Names of folders directly under the root whose own `.claude/` settings, hooks, `.mcp.json` and `CLAUDE.md` load in a chat bound to that folder. Default empty. See [Sessions](/api/sessions#post-apiv1agentsagentidsessions). |
| `enabled` | `false` leaves the files and git routes unmounted and refuses folder-bound chats. Default `true`. |

Changing any of them takes effect after a gateway restart. Other keys inside `gateway.files` are ignored, and the
gateway logs a warning that names them.

**The old key.** `gateway.projects` was renamed to `gateway.files`. A `config.json` that still holds
`gateway.projects` fails to load with `gateway.projects was renamed to gateway.files; move its root, trusted and
enabled keys there`. Move the block by hand: the gateway reads no alias.

**Safety checks on the root.** The gateway trims the root and strips trailing slashes before it checks and uses it,
so `" ~/projects/ "` and `~/projects` are one root.

- The root must not be `/`, your home directory, `~/.claude-gateway`, the directory holding `config.json`, or any
  directory that contains one of them. The check follows symlinks. A root set in `config.json` that breaks this rule
  stops the gateway from loading.
- A root spelled like the default (`config.template.json` ships `"~/projects"`) counts as unset. When the default
  breaks the rule above, for example because `~/projects` is a symlink to HOME, the gateway logs a warning and sets
  `enabled` to `false` instead of refusing to start.
- A root that holds `:`, or that resolves through a symlink to a path holding `:`, is not supported, because git's
  discovery fence is a `:`-separated list. The gateway logs a warning and sets `enabled` to `false`.

**Requirements and files on disk.** The git routes need `git` 2.26 or newer (see [Git](/api/git#requirements)). The
gateway writes these files:

| Path | Holds |
| ---- | ----- |
| `<agent dir>/project-bindings/<sessionId>.json` | Which folder a chat is bound to. Written only for folder-bound chats and deleted with the session |
| `<parent>/.deleting-<name>-<id>` | What a `DELETE` could not remove. Safe to delete by hand |

## Paths {#paths}

Each folder name in a path matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. So no segment can be `.`, `..`, empty, or
start with a dot or a dash, and the hidden `.deleting-*` folders a failed delete leaves are out of reach. A path has
at most 32 segments, no leading or trailing `/`, and no `//`.

The gateway resolves every path through symlinks with `realpath`, and refuses one whose real location is outside the
root (`403 path_escape`). A link inside the root that points back at the root itself, such as `all -> .`, is refused
the same way, so no entry can span every other one.

## Errors {#errors}

Every error has the shape `{ "error": string, "code": string }`. Branch on `code`; `error` is human-readable and may
change. Some git errors add fields. This one table covers every files and git route. A request without a valid key
gets the gateway's usual `401` or `403` before it reaches these routes.

| Status | `code` | When |
|--------|--------|------|
| 400 | `invalid_path` | `path` is not a string, is absolute, has an empty segment, has more than 32 segments, or names the root where a folder is required (mkdir, delete, git status). |
| 400 | `invalid_name` | A segment of `path` fails the [name rule](#paths). |
| 400 | `not_a_directory` | The path names a file, a link to a file, or the root exists but is not a directory. |
| 400 | `confirm_mismatch` | `DELETE` did not send `confirm` equal to the last segment of `path`. |
| 403 | `path_escape` | The real path (after symlinks) leaves the root, or is the root itself. |
| 403 | `permission_denied` | The gateway's user cannot read or change it. |
| 403 | `forbidden_key` | mkdir or delete with a key that is not an admin key. |
| 404 | `not_found` | The folder, or the parent of a new folder, does not exist. |
| 409 | `already_exists` | mkdir named a folder, file or symlink that already exists, compared case-insensitively (`Site` collides with `site`). |
| 409 | `symlink_in_path` | `DELETE` of a nested path whose parent folders include a symbolic link. |
| 409 | `cross_device` | `DELETE` of a folder on another filesystem than its parent, or one that holds a mount point. |
| 409 | `in_use` | `DELETE` found a chat or task working in the folder, in a folder inside it, or in a folder holding it. |
| 409 | `deleting` | The folder, a folder inside it, or a folder holding it is being deleted by another request. |
| 409 | `not_a_git_repo` | Git status of a folder that is not a repository. |
| 409 | `git_unsafe_owner` | The repository belongs to another user and git refuses it. |
| 409 | `git_unreadable` | The folder has a `.git` that git cannot read safely. |
| 500 | `git_failed` | Any other git failure. Git's output is not returned. |
| 500 | `internal` | Any other filesystem error, or an unexpected failure inside the gateway. The body is `{ "error": "Internal error", "code": "internal" }` and the gateway logs only the error's class and errno code. |
| 503 | `git_unavailable` | Git is not installed, or is not on the gateway's `PATH`. |
| 504 | `timeout` | Git ran past its limit of 3 seconds. |

The JSON Schemas of every request and response, and golden fixtures recorded from a real gateway, are in
`contracts/files-git/` of the gateway repository. `npm run contracts:fixtures` records them again.

## GET /api/v1/files {#get-files}

List the folders directly under `path`, sorted by name. Only directories, and symlinks that resolve to a directory
inside the root, are listed. Files are left out. When the root does not exist, a listing of the root has
`exists: false`, and the gateway does not create it. A missing folder under an existing root is `404 not_found`.

| Query | Required | Description |
|-------|----------|-------------|
| `path` | No | The folder to list. Absent or empty lists the root. |

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:10850/api/v1/files?path=site"
```

```json
{
  "root": "/home/user/projects",
  "exists": true,
  "path": "site",
  "abs": "/home/user/projects/site",
  "entries": [
    { "name": "web", "path": "site/web", "abs": "/home/user/projects/site/web", "type": "dir", "modified_at": "2026-10-06T07:41:58.706Z", "is_git": true }
  ]
}
```

`root` is the root resolved through symlinks, or the configured spelling when it does not exist. `abs` of the listing
is the listed folder's real path, and each entry's `abs` is that joined with the entry's name. `type` is always `"dir"`
today; a later release may add other types. `is_git` is true when the folder has a `.git` entry (a directory, or the
file a worktree or submodule uses).

Folders the list leaves out are reported in two optional arrays, so a client can tell the user why a folder is
missing. Both are absent when empty.

- `skipped` holds `{ "name", "reason" }` for each folder or link that is not listed, sorted by name, at most 50.
  `reason` is `invalid_name` (the [name rule](#paths) rejects it), `symlink_outside_root` (a link whose target is
  outside the root, or is the root itself) or `not_a_directory` (a link to a file). Loose files and broken links are
  not reported.
- `leftovers` holds the names of hidden `.deleting-*` folders in the listed folder, sorted, at most 50. They are what a
  [`DELETE`](#delete-files) could not remove. The gateway never sweeps them.

## POST /api/v1/files/mkdir {#post-files-mkdir}

Create exactly one new folder. Its parent must already exist under the root, except that a missing root is created
first. Needs an admin key. Returns `201` with the new folder as `entry`, in the shape [the list](#get-files) uses.

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | The new folder, such as `site` or `site/web`. |
| `git_init` | No | When `true`, run `git init -q` in the new folder (10 second timeout). Any other value is ignored. |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"path":"demo","git_init":true}' http://localhost:10850/api/v1/files/mkdir
```

```json
{ "entry": { "name": "demo", "path": "demo", "abs": "/home/user/projects/demo", "type": "dir", "modified_at": "2026-10-06T07:41:58.686Z", "is_git": true } }
```

If the name is taken, compared case-insensitively within the parent, the response is `409 already_exists` and the
existing entry is not touched. Creates in one parent run one at a time, and the create is an atomic `mkdir`, so of
several concurrent requests for one name exactly one gets `201`. A missing parent is `404 not_found`, and nothing is
created above the new folder. If `git init` fails, the folder is kept and the response is still `201`, with a
`warning` that names only the exit code, the signal, or the spawn error (such as `ENOENT` when git is not installed).
Git's output goes to the gateway log, never to the client.

```json
{
  "entry": { "name": "nogit", "path": "nogit", "abs": "/home/user/projects/nogit", "type": "dir", "modified_at": "2026-10-06T07:41:58.698Z", "is_git": false },
  "warning": "git init failed (ENOENT)"
}
```

## DELETE /api/v1/files {#delete-files}

Delete the folder `path` names and everything in it. Needs an admin key. Returns `200` with `{ "path": "<path>" }`.
This cannot be undone, and the gateway keeps no copy. The request has a JSON body.

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | The folder to delete. The root itself is refused with `400 invalid_path`. |
| `confirm` | Yes | The last segment of `path`, exactly: `web` for `site/web`. Anything else is `400 confirm_mismatch`. |

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"path":"site/node_modules","confirm":"node_modules"}' http://localhost:10850/api/v1/files
```

**What it refuses.**

- A path whose real location leaves the root, or is the root (`403 path_escape`).
- A nested path whose parent folders include a symbolic link (`409 symlink_in_path`). Only the last segment may be a
  link.
- A folder on another filesystem than its parent, or one that holds a mount point (`409 cross_device`). A delete never
  reaches into another filesystem.
- A folder in which a chat turn is in flight, a session is still starting, an accepted message is not yet handled, or
  an orchestrated task has not finished, and a folder that holds or sits inside such a folder (`409 in_use`). Deleting
  the chat session does not release it while its turn, message or task is still live.
- A folder that overlaps one another `DELETE` is removing (`409 deleting`). While a delete runs, a message or task in a
  chat bound to that folder fails with `409 PROJECT_UNAVAILABLE` (`reason` `project_deleting`).

The gateway does not check for other processes, such as a dev server, that run inside the folder: stop them before
you delete.

**How it removes.** A path whose last segment is a symlink loses only the link, never what it points to. Otherwise
the folder is first renamed to a hidden sibling `.deleting-<name>-<id>`, so it leaves every listing in one step and its
name is free at once. Links inside the folder are removed, never followed. If some files cannot be removed, for
example a subfolder without write permission, the response is still `200` and adds a `warning` naming the folder to
remove by hand (`rm -rf <parent>/.deleting-<name>-<id>`). The folder is also listed in `leftovers` of
[the list](#get-files) of its parent. A folder is never left listed with part of its files gone. Chats bound to a
deleted folder are kept, and their folder no longer resolves.
