# Projects API {#projects-api}

List the project directories under the pod's projects root, `~/projects` by
default. The web dashboard uses these routes to list projects, create and delete
one, and read the git status of each project. The gateway does not serve project files: it has no route that lists a
project's folders or returns a file's contents. View project files in
code-server. Editing files and changing a repository (commit, push, pull) are
out of scope too. Use code-server or the git connector for that.

**Auth.** Projects belong to the pod, not to an agent, so any valid API key can read the list and git status.
Creating and deleting a project
change the pod and need an admin API key (`admin: true`). Any other key, a pod-wide write key included, gets
`403 forbidden_key` on those two routes, with the message `An admin API key is required for Projects`.
A project-bound chat belongs to its agent and follows the agent's rules like any other chat: see
[Sessions](/api/sessions#post-apiv1agentsagentidsessions).

**Feature detection.** `GET /api/v1/capabilities` lists
`"projects": ["list", "create", "git", "chat", "delete"]` for an admin key.
A key that is not an admin key gets `["list", "git", "chat"]`. Show the project list
only when the array includes `"list"`, project create only when it includes `"create"`, the git status view only when it includes `"git"` (read-only: the gateway has no route that changes a repository),
and [project-bound chat](/api/sessions#post-apiv1agentsagentidsessions) only when
it includes `"chat"`. Show the Delete action only when it includes `"delete"`.
When the array is empty, `projectsUnavailable` is `"disabled"`: the gateway serves no Projects API. The field is
absent when Projects is usable. An older gateway omits the key, lists projects without
`"git"` or `"chat"`, or answers `"admin_required"` for a key that is not an admin key.

**On by default.** The routes are on for every install, with the root `~/projects`, and
need no configuration. Every valid key can list the projects in that folder and read their git status, and every key with
`admin: true` can also create and delete projects there. To switch Projects off, set
`gateway.projects.enabled` to `false` and restart. Only a boolean counts: the string `"false"`, `0` or `null` is
ignored with a warning in `gateway.log`, and Projects keeps its default, which is on:

```json
{ "gateway": { "projects": { "enabled": false } } }
```

**Security model.** An admin key can do everything, for every agent. Any other key reaches the agents it lists
(or every agent with `agents: "*"`), can write only when it has `write: true`, and can list every project
and read its git status. Admin-only means only create and delete. The gateway does
not serve project files to any key, so files are viewed in code-server. The git routes remove credentials from
remote URLs. Every listing also carries the host path of the projects root as `root`, which usually includes the home directory.
These checks are not a filesystem boundary.
Agents run with `--dangerously-skip-permissions`, and a project-bound chat runs its agent inside the project
folder, so any key that can send that agent a message can ask it to read or change any file in the project, or
any other file the gateway's user can reach. Sending a message does not need `write`, so this includes a
read-only key that lists the agent. Projects are shared by every agent, so such a key can change a project that
other agents' chats also work in. On a host-mode orchestrated agent, `task_spawn` accepts any absolute
`working_directory`, so a worker can run inside a project folder without a project-bound chat. This predates
Projects. Treat an admin key as full access to the pod, and treat a key that can reach an agent as able to
change every project folder.

**Isolated memory agents.** An agent with `isolateMemory: true` can chat in a project like any other host agent, and the project is not split per conversation. Every chat bound to the project works in the same folder, so what one conversation writes there reaches the others. A trusted project also loads its own settings, hooks and `.mcp.json`, so its MCP servers reach the session although isolated memory mode gives a session none of the operator's. Bind a chat of an isolated agent only to a project its conversations may share, and leave that project out of `gateway.projects.trusted`. App agents cannot chat in a project (`409 project_unsupported_agent`, reason `container`).

**Root.** Projects live in `gateway.projects.root`, which defaults to
`~/projects`. Every listing returns the root as `root`, resolved through
symlinks when it exists, so a client never has to rebuild it. The gateway follows symlinks with `realpath` and refuses any project
whose real location is outside the root, or is the root itself.

**Disabled.** When the default root would expose your home or config directory, the gateway logs a warning and does not mount these routes: they answer `404`, `capabilities.projects` is empty, and `POST /sessions` with `project` answers `409 projects_disabled`. Sessions already bound to a project fail with `409 PROJECT_UNAVAILABLE`. Set `gateway.projects.root` to a folder that holds only projects to re-enable. A `root` that is spelled like the default, spaces and trailing slashes aside (`config.template.json` ships `"~/projects"`, and the config migration copies it into old configs) counts as unset, so it warns and disables the routes instead of stopping the gateway. Any other unsafe `root` stops the gateway from loading.

**Configuring the root.** Set `gateway.projects.root` in `config.json` to an
absolute path or a path starting with `~/`:

```json
{
  "gateway": {
    "projects": { "root": "/srv/projects" }
  }
}
```

The gateway rejects a configuration
whose root is `/`, your home directory, `~/.claude-gateway`, the directory holding
`config.json`, or any directory that contains one of them. Changing the root
takes effect after a gateway restart. The gateway trims the root and strips trailing slashes before it checks and
uses it, so `" ~/projects/ "` and `~/projects` are one root. A root holding `:` is not supported, because git's
discovery fence is a `:`-separated list: the gateway logs a warning and disables Projects. Keys other than `root`, `trusted` and `enabled`
inside `gateway.projects` are ignored, and the gateway logs a warning that names them.

**Requirements and files.** Projects needs `git` 2.26 or newer on the pod. The read calls
(`git status --porcelain=v2`, `rev-parse --absolute-git-dir`, `log`, `rev-list`) work from 2.13,
but the check that blanks a repository's own filter commands uses `git config --show-scope`
(2.26). On an older git that check finds nothing, and the filter protection below does not apply. Projects writes
these files:

| Path | Holds |
| ---- | ----- |
| `<agent dir>/project-bindings/<sessionId>.json` | Which project a chat is bound to. Written only for project chats and deleted with the session |
| `<root>/.deleting-<name>-<id>` | What a `DELETE` could not remove. Safe to delete by hand |

**Downgrading.** Gateways without Projects ignore the `projects` block. A project chat opened
on this version then runs in the agent workspace, and a project task still queued at the time runs
without the untrusted-settings guard. Let queued project tasks finish, or cancel them, before you
downgrade.

## Errors {#errors}

Every error has the shape `{ "error": string, "code": string }`. Branch on
`code`; `error` is human-readable and may change. The git routes add their own
codes, listed under [Git errors](#git-errors). The one exception is an unexpected failure inside
the gateway, which answers `500` with `{ "error": "Internal error" }` and no `code`.

| Status | `code` | When |
|--------|--------|------|
| 400 | `invalid_name` | The project name fails the name rules below. |
| 400 | `not_a_directory` | The project is a link to a file, or the root exists but is not a directory. |
| 403 | `path_escape` | The project's real path (after symlinks) leaves the root or is the root itself (for example a link `all -> .`). |
| 403 | `permission_denied` | The gateway's user cannot read it. |
| 403 | `forbidden_key` | Create or delete with a key that is not an admin key. |
| 404 | `not_found` | The project does not exist. |
| 400 | `confirm_mismatch` | `DELETE` did not send `confirm` equal to the project name. |
| 409 | `project_exists` | `POST` named a project, file or symlink that already exists, compared case-insensitively (`Site` collides with `site`). |
| 409 | `project_running` | `DELETE` found a chat turn running in the project (a turn still starting, an accepted message not yet handled, or a task that has not finished), or a chat or task that works in the folder through a symlink alias. Deleting the chat session does not release it while its turn, accepted message or task is still live. |
| 409 | `project_deleting` | The project is being deleted: a second `DELETE` of the same folder (by its name or through a symlink alias) found the delete already in progress. |
| 500 | `internal` | Any other filesystem error. |

**Project name.** Matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Directories under
the root whose names do not match are not listed.

## GET /api/v1/projects {#get-projects}

List the projects, sorted by name. Only directories, and symlinks that resolve
to a directory inside the root, are listed. When the root does not exist the
response has `exists: false`, and the gateway does not create it.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects
```

```json
{
  "root": "/home/user/projects",
  "exists": true,
  "projects": [
    { "name": "demo", "path": "/home/user/projects/demo", "modified_at": "2026-10-06T07:41:58.706Z", "is_git": true }
  ]
}
```

Folders the list leaves out are reported in two optional arrays, so a client can tell the user
why a folder is missing. Both are absent when empty, and `projects` is not affected by them.

- `skipped` holds `{ "name", "reason" }` for each folder or link that is not a project, sorted by
  name, at most 50. `reason` is `invalid_name` (the [name rules](#errors) reject it: a space,
  non-ASCII letters, a leading dot or dash, or more than 64 characters), `symlink_outside_root` (a
  link whose target is outside the root, or is the root itself) or `not_a_directory` (a link to a file). Loose files and
  broken links are not reported.
- `leftovers` holds the names of hidden `.deleting-*` folders in the root, sorted, at most 50. They
  are what a [`DELETE`](#delete-project) could not remove. The gateway never sweeps them.

`is_git` is true when the project has a `.git` entry (a directory, or the file a
worktree or submodule uses).

## POST /api/v1/projects {#post-projects}

Create `<root>/<name>`, creating the root first if needed. Needs an admin key. Returns
`201` with the new project in the same shape [the list](#get-projects) uses.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Project name. |
| `git_init` | No | When `true`, run `git init -q` in the new directory (10 second timeout). |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"demo","git_init":true}' http://localhost:10850/api/v1/projects
```

```json
{ "project": { "name": "demo", "path": "/home/user/projects/demo", "modified_at": "2026-10-06T07:41:58.686Z", "is_git": true } }
```

If the name is already taken the response is `409 project_exists` and the
existing entry is not touched. The create is an atomic `mkdir`, so of several
concurrent requests for one name exactly one gets `201`. If `git init` fails, the directory is kept
and the response is still `201`, with a `warning`. The warning names only the
exit code, the signal, or the spawn error (such as `ENOENT` when git is not
installed). It never includes git's output, which the gateway logs instead.

```json
{
  "project": { "name": "nogit", "path": "/home/user/projects/nogit", "modified_at": "2026-10-06T07:41:58.698Z", "is_git": false },
  "warning": "git init failed (ENOENT)"
}
```

## DELETE /api/v1/projects/:name {#delete-project}

Delete `<root>/<name>` and everything in it. Needs an admin key. Returns `200` with `{ "name": "demo" }`. This cannot
be undone, and the gateway keeps no copy.

| Field | Required | Description |
|-------|----------|-------------|
| `confirm` | Yes | The project name again, exactly. Anything else is `400 confirm_mismatch`. |

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"confirm":"demo"}' http://localhost:10850/api/v1/projects/demo
```

While a chat bound to the project has a turn in flight, the response is `409 project_running` and
nothing is removed. Wait for or stop the chat turn. The gateway does not check for processes, such
as a dev server, that run inside the folder: stop them before you delete. While a delete is in progress,
a message or task start in the project fails with `409 PROJECT_UNAVAILABLE` (`reason`
`project_deleting`), and a second `DELETE` answers `409 project_deleting`. Links inside the project
are removed, never followed, so a link out of the project cannot delete what it points to. A
project that is itself a link out of the root answers `403 path_escape` and is left alone. Chats
that were started in the project are kept, and their project no longer resolves.

The folder is first moved to a hidden `<root>/.deleting-<name>-<id>` folder, so the project leaves
the list in one step and its name is free at once. If some files there cannot be removed, for
example a subfolder without write permission, the response is still `200` and adds a `warning`
naming the exact folder to remove by hand (`rm -rf <root>/.deleting-<name>-<id>`). The folder is also listed in `leftovers` of [`GET /api/v1/projects`](#get-projects). A project is never left listed with part of its files gone.

## Git {#git}

The git routes read the status of a project that is a git repository. They
change nothing. A project is a repository only when its own directory holds the
repository. A plain folder inside a repository is not one. The gateway runs `git`
directly, never through a shell, and never prompts for credentials
(`GIT_TERMINAL_PROMPT=0`). To change a repository (commit, push, pull), use the
git connector or code-server. The one write is `git_init` on
[`POST /api/v1/projects`](#post-projects), which runs `git init -q` in the new,
empty directory.

Git, and every filter it starts, gets only these environment variables from the
gateway. Everything else, including the gateway's own API keys, bot tokens and
provider keys, is dropped.

| Variables | Why |
| --------- | --- |
| `PATH` | Finds `git` and the operator's filter programs, such as `git-lfs`. |
| `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM` | Select the operator's config files: filters (`git lfs install`), `safe.directory`. |
| `TMPDIR` | Temporary files. |

Git itself runs with `LC_ALL=C`. `GIT_DIR` and `GIT_WORK_TREE` from the gateway's
environment are never passed. When git runs past its time limit, the gateway
stops git and every process git started, such as filters. It sends `SIGTERM`
first so git removes its lock files, then `SIGKILL` one second later.

#### What a hostile repository cannot make a read run {#git-hostile}

A project folder can come from anywhere, and git runs commands that a
repository's own config names. Every read (`status`, `rev-parse`, `log`,
`rev-list`, `config`) and the `git init` of `git_init` run with these settings.

| Setting | What it stops |
| ------- | ------------- |
| `GIT_ALLOW_PROTOCOL` set empty | Every transport: ssh, http(s), git, file and `ext::`. A repository cannot undo it: `protocol.<name>.allow=always` in its config does not outrank the environment, though it does beat a global `protocol.allow=never`. Git can start a fetch during a read, to get an object a partial clone left out, so this is what keeps `core.sshCommand`, `core.askPass`, `remote.<name>.uploadpack`, `ext::` URLs and `credential.helper` from running. Such a read fails and the project reads as `null` in the list. `credential.helper` and `core.sshCommand` in the repository are never reached, because no connection is opened. |
| `GIT_NO_LAZY_FETCH=1` | Git 2.44 and later do not try the lazy fetch at all. Older git tries it and the line above stops it. |
| `core.fsmonitor=false` | The command named by `core.fsmonitor`. |
| Every `filter.*` key the repository defines set to empty | The filter drivers that the repository's own config defines. `status` runs a driver's clean command on any file whose timestamp changed, so it would run it. The gateway asks git for the drivers (`git config --list --show-scope`) and blanks those in the `local` and `worktree` scopes, which covers `.git/config`, `config.worktree`, files they include (also nested, and `includeIf`), a `.git` file that points elsewhere, and the config of a linked worktree's main repository. It does not parse config text. The driver is found whichever way `.gitattributes`, `.git/info/attributes` or `core.attributesFile` names it. The operator's own drivers in `~/.gitconfig` or `/etc/gitconfig` still run, such as `git lfs install`. A repository that defines `git lfs` locally (`git lfs install --local`) reads its LFS files as the raw pointer, so they can show as modified. |
| `--ignore-submodules=dirty` | `status` does not enter a submodule's worktree, where its own config and filters would apply. Only a changed submodule commit shows. |
| `--no-show-signature` on `log` | `log.showSignature` would run the repository's `gpg.program`. |
| `--no-optional-locks` | `status` never takes `.git/index.lock` from a git command you run in the same folder. |

The keys are passed to git whole, in its environment, which can carry only valid UTF-8. A repository is therefore
not read, and answers `409 git_unreadable` (`git-summary` shows `null` for it), when it defines more than 64
`filter.*` keys (a driver with `clean`, `smudge`, `process` and `required` counts 4, so about 16 drivers), a key
longer than 1024 characters, or a `filter.*` key that is not valid UTF-8.

Not neutralized, and not reachable from a read: hooks (`status`, `log` and
`rev-parse` run none), `diff` and `merge` drivers and textconv (not used by a
status), `core.pager`, `core.editor`. The operator's config is trusted: a
filter or `safe.directory` set in `~/.gitconfig` or `/etc/gitconfig` applies, and so do `HOME`, `XDG_CONFIG_HOME`,
`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM` from the gateway's environment. Its
`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>` and `GIT_CONFIG_PARAMETERS` are dropped.

Credentials in a remote URL (`https://user:token@host/x`) are removed from
every git route response and log line. Git's own output never reaches the client.

### GitStatus {#git-status}

| Field | Type | Meaning |
|-------|------|---------|
| `branch` | `string \| null` | Current branch, also before its first commit. `null` only when HEAD is detached. |
| `detached` | `boolean` | HEAD is detached. |
| `has_commits` | `boolean` | `false` right after `git init`. |
| `upstream` | `string \| null` | The upstream setting, such as `origin/main`, even when no online copy was found. |
| `ahead`, `behind` | `number` | Commits ahead of and behind the upstream, as of the last fetch. `0` when `sync` is `upstream_gone`. Before the first commit, `behind` counts every commit of the upstream. |
| `sync` | `string` | One of `in_sync`, `ahead`, `behind`, `diverged`, `no_upstream`, `upstream_gone`, `upstream_mismatch`, `no_remote`, `detached`. See [Sync values](#git-sync). Treat a value you do not know as neutral. |
| `remote` | `GitRemote \| null` | The upstream's remote, else `origin`, else the only remote. |
| `changes` | `GitFileChange[]` | At most 200, ordered conflicted, staged, unstaged, untracked. |
| `change_count` | `number` | The true number of changed files. |
| `conflicted_count` | `number` | Files with merge conflicts. |
| `truncated` | `boolean` | `changes` was cut at 200. |
| `last_commit` | `GitCommitInfo \| null` | The HEAD commit. |
| `operation` | `string` | `none`, `merge`, `rebase`, `cherry_pick`, `revert`, or `bisect`. |

#### Sync values {#git-sync}

| `sync` | Meaning |
|--------|---------|
| `in_sync`, `ahead`, `behind`, `diverged` | Compared with the upstream, as of the last fetch. |
| `no_upstream` | A remote exists but the branch tracks nothing. Also a branch with no commits whose upstream has no commits online, such as a clone of an empty repository. |
| `upstream_gone` | The branch has commits and an upstream setting, but no online copy was found: it was removed, or it was never fetched. |
| `upstream_mismatch` | The upstream is not a branch of the same name on a configured remote, such as a branch made with `git checkout -b feature origin/main`, or one that tracks a local branch. `ahead` and `behind` are still reported. |
| `no_remote` | The repository has no remote. |
| `detached` | HEAD is detached. |

A branch with no commits whose upstream has commits online reports `behind`
with `has_commits: false`.

`GitFileChange` is `{ path, orig_path?, staged, unstaged }`. `path` is relative
to the project with forward slashes. `orig_path` is set for renames and copies.
`staged` and `unstaged` are each `null` or one of `added`, `modified`,
`deleted`, `renamed`, `copied`, `type_changed`, `untracked` (unstaged only), or
`conflicted` (on both sides).

`GitRemote` is `{ name, url, host, web_url }`. `host` is `github`, `gitlab`,
`bitbucket`, or `other`. `web_url` is the repository's web page for the first
three, else `null`.

`GitCommitInfo` is `{ sha, subject, author, committed_at }`, with
`committed_at` in ISO 8601.

### GET /api/v1/projects/git-summary {#get-git-summary}

A slim status for every project that is a git repository, for project cards.
Plain folders are left out. A repository whose status takes longer than 3
seconds or fails maps to `null`. The gateway reads at most 4 repositories at a
time, and each read runs 2 git processes one after the other (the config, then the status), so one request keeps up to 4
git processes running and spawns 2 per repository, 3 for an unborn branch that has an upstream (measured: 400 for 200 repositories with commits). `GET /api/v1/projects`
spawns none, since it only looks at the filesystem. To stay fast, `change_count` counts an untracked folder as one change,
so it can be lower than the `change_count` of the full status.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects/git-summary
```

```json
{
  "summaries": {
    "app": { "branch": "main", "detached": false, "sync": "in_sync", "ahead": 0, "behind": 0, "change_count": 0, "conflicted_count": 0, "remote_host": "github" },
    "slow": null
  }
}
```

### GET /api/v1/projects/:name/git {#get-git}

Returns `200` with a [GitStatus](#git-status). A read spawns 4 git processes (5 for an unborn branch that has an upstream, which also counts the commits to pull): the config first, then `rev-parse`, `status` and `log` at once. The 3 second limit covers the whole read.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects/app/git
```

```json
{
  "branch": "main",
  "detached": false,
  "has_commits": true,
  "upstream": "origin/main",
  "ahead": 1,
  "behind": 0,
  "sync": "ahead",
  "remote": { "name": "origin", "url": "https://github.com/acme/app.git", "host": "github", "web_url": "https://github.com/acme/app" },
  "changes": [
    { "path": "README.md", "staged": null, "unstaged": "modified" },
    { "path": "notes.md", "staged": null, "unstaged": "untracked" }
  ],
  "change_count": 2,
  "conflicted_count": 0,
  "truncated": false,
  "last_commit": { "sha": "5e67…", "subject": "Update readme", "author": "Ann Dev", "committed_at": "2026-10-07T12:20:33+07:00" },
  "operation": "none"
}
```

### Git errors {#git-errors}

| Status | `code` | When |
|--------|--------|------|
| 409 | `not_a_git_repo` | The project is not a repository. |
| 409 | `git_unsafe_owner` | The repository belongs to another user and git refuses it (`detected dubious ownership`). Run `git config --global --add safe.directory <path>` as the gateway's user, or change the owner. `git-summary` shows `null` for it and the other repositories still read. |
| 409 | `git_unreadable` | The folder has a `.git` that git cannot read: no permission, a `.git` file that points nowhere, a damaged config, or a repository that defines more `filter.*` keys than the gateway blanks. |
| 503 | `git_unavailable` | Git is not installed, or is not on the gateway's `PATH`. `git-summary` answers it too, since no repository can be read. The gateway logs a warning once. |
| 504 | `timeout` | Git ran past its limit of 3 seconds. |
| 500 | `git_failed` | Any other git failure. Git's output is not returned. |
