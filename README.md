# Tinner — deterministic Adamantium-node project slicer

## v1.0 — separate Godot game smoke and Engine C++ build acceptance

Tinner can validate either kind of Godot source **before publishing** a new live graph revision, without a model/API call. Both validators are explicitly opt-in and run a verified, independently restored copy in a disposable Docker container, never the original source. Docker is not sufficient isolation for hostile code; use a dedicated, low-privilege host or VM for untrusted projects.

### Godot game: import plus explicit headless smoke scene

The game validator now runs Godot's editor `--import` stage and, optionally, a second headless process to execute a user-selected `.tscn` for up to 120 frames. A nonzero exit, timeout, or recognized error output at either stage blocks promotion.

```sh
# Choose a trusted, already present Godot 4 editor image:
tinner project-validate ./game-bundle   --validate-image=my-godot-editor:4.x   --smoke-scene=res://tests/smoke.tscn

# Unattended, content-hash change detection and verified revision publication:
tinner live-watch ./godot-game ./live 15000 3   --validate-image=my-godot-editor:4.x   --smoke-scene=res://tests/smoke.tscn
```

The scene must exist **inside the archived project**. An arbitrary path, traversal or missing scene is rejected before launching Docker. Scene execution may run game scripts, so it uses the same offline/no-new-privileges container restrictions as import validation. Exit code 0 only proves this short smoke check completed without the recognized Godot error diagnostics, not that gameplay or all tests are correct.

### Godot Engine: compile Linux editor from full C++ checkout

Use a **trusted preinstalled** Docker builder image with SCons, C/C++ compilers and all Godot 4 Linux build dependencies. Tinner restores the engine source into a temporary writable workspace, then runs:

```text
scons -Q -j2 platform=linuxbsd target=editor
```

The build container has no network or added Linux capabilities, a read-only root filesystem, 2 CPU, an 8 GiB RAM limit and a 60 minute default timeout. A successful **zero exit code is not enough**: Tinner also requires a nonempty `bin/godot.linuxbsd.editor.*` output and hashes the binary. The output is discarded with the temporary workspace after validation; this is an **acceptance gate**, not a compiled-binary release exporter.

```sh
tinner project-engine-validate ./engine-bundle   --engine-build-image=my-godot-scons-builder:4.x --build-jobs=2

tinner live-watch ./godot-engine ./engine-live 60000 3   --engine-build-image=my-godot-scons-builder:4.x --build-jobs=2
```

A failed build or missing binary leaves the previous graph revision active. Changing the validation mode or builder image requires a fresh accepted revision, even if source files are unchanged. Game-validator and Engine-validator modes cannot be enabled together.

**Limits:** only Godot 4 **Linux editor** (`platform=linuxbsd target=editor`) is supported here. No Windows/macOS build, gameplay equivalence, C#/.NET assembly build, export template or native code-to-node transpilation is claimed. Large checkouts still cost disk/CPU despite incremental graph reuse. The CI tests the command construction, resource restrictions, refusal paths, mock binary verification and rejection of failed scene/build steps with injected subprocess mocks. It **does not invoke Docker or compile a real Godot checkout**; do not assume actual platform build success without running it on the target machine.

Official references: Godot stable [Linux compilation instructions](https://docs.godotengine.org/en/stable/engine_details/development/compiling/compiling_for_linuxbsd.html) and [headless/scene command line options](https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html).

## v0.9 — opt-in Godot acceptance gate (Docker, no AI)

**Why opt-in?** A Godot Editor import can execute editor extensions and tool scripts. Running it directly on the host against an untrusted project is unsafe. Tinner now validates the **verified, restored project copy** in a disposable Docker container, never the original Godot source.

Requirements: Docker installed and authorized; a **locally downloaded, operator-trusted** container image with a `godot` executable on its PATH (Godot 4 editor binary; image must be selected explicitly). For example, if you've already installed your own trusted `my-godot-validator:4.x` image:

```sh
# Standalone check of a previously exported bundle:
tinner project-validate ./godot-graph --validate-image=my-godot-validator:4.x

# Each new live revision is checked BEFORE current.json is promoted:
tinner live-watch ./godot ./tinner-live 15000 3 --validate-image=my-godot-validator:4.x

# Or one manual poll:
tinner live-scan ./godot ./tinner-live 2000 3 --validate-image=my-godot-validator:4.x
```

The validation runner:
- Verifies archive hashes, restores a separate temporary project and invokes `docker run --rm` with `--headless --path /workspace/project --import`. This is the Godot editor's headless import operation, **not** a complete test suite, gameplay check or a compiled C++ Godot Engine build.
- Uses `--pull=never`, no network, a read-only container rootfs, no Linux capabilities, no new privileges, CPU/memory/PID limits, and only a disposable project-directory bind mount. No original source directory, Docker socket or user secrets are mounted.
- Enforces a 90-second default timeout and fails on nonzero exit or recognized `ERROR:`/`SCRIPT ERROR:` diagnostics. The process exit code and bounded logs are written as `last-validation.json` in the live state directory for inspection.
- Leaves the previous published revision untouched when Godot validation rejects a candidate. Running with an image for the first time forces a new checked revision even if files are unchanged. If Docker or Godot is absent, **verification fails closed rather than silently passing**.
- Rejects validation of Godot Engine C++ source tree: this mode needs an independent compiler-backed pipeline, not editor import.

**Security and evidence:** Docker reduces exposure but is not a hardened sandbox for arbitrary hostile code; use a dedicated, minimally privileged runner for untrusted projects. Images are not downloaded automatically. The isolated command is **not run by repository CI**: unit tests use an injected fake subprocess runner to verify gating and Docker command construction; actual Godot binary compatibility remains to be tested on a provisioned machine. Don't describe v0.9 as tested with a real Godot executable yet.

By default no external engine is invoked: the watcher remains purely deterministic and AI-free, with opt-in validation controlled by CLI arguments.

## v0.8 — content-addressed change detection and bounded revision retention

Tinner Live now **streams SHA-256 over every source file** on each polling pass. Changes are decided from file-content hashes, not file size, modification time or inode. Metadata snapshots remain available for detecting source races during a rebuild. A file whose timestamp changes but content is identical no longer triggers an unnecessary graph revision. Previously created v0.7 live states are supported: on the first scan the prior verified project manifest supplies missing hashes.

When a new revision is produced, its candidate archive is still independently verified, and its source-file checksums must agree with the *beginning and end* of that scan before the active pointer can change. On a scan failure, the last active revision stays unchanged.

Unattended update with **optional** archive retention:

```sh
# poll every 15 s, retain up to 3 revision bundles (always keep current + previous)
tinner live-watch ./godot-game ./tinner-live 15000 3

# See deletion candidates without deleting anything
tinner live-prune ./tinner-live 3

# Explicitly apply deletion after inspecting the dry-run
tinner live-prune ./tinner-live 3 --apply
```

The `max-revisions` parameter is *opt-in*. Without it, the watcher retains every revision. With it, the watcher validates all deletion candidates before removing old Tinner-managed revision folders. The active and directly previous revisions are **never** removed. A bad archive or an active writer lock fails closed; a post-publication retention error is reported separately and never re-labels a successfully published revision as failed. No input Godot source file is ever deleted by the retention operation.

**Performance caveat:** secure content detection scans each project's entire byte volume every poll. This may be costly for a full Godot Engine tree or slow HDD. Use a longer polling interval and opt in to pruning only after checking disk budget. Even in v0.8, whole-revision checks and graph rebuilding remain; only unchanged per-file source transformations are reused. The flow graphs remain inert and no Godot execution/compiler validation or runtime hot swap is claimed.

## v0.7: Verified per-file reuse across live revisions

The same `live-scan` and `live-watch` commands now reprocess **only files whose filesystem metadata changed**. Unchanged text chunks, source-slice flows, static symbol indexes and binary assets are copied from the previous checksum-verified revision. Where the filesystem supports it, copy-on-write clones minimize physical storage for unchanged data; otherwise ordinary copies are made.

The complete dependency map and global symbol graph are re-evaluated from stored per-file metadata on **every changed revision**. This means adding or removing a file updates existing `res://` and C++ include resolution even if the referencing source wasn't edited. Reused individual function flows retain their deterministic IDs; generated graph checksums are verified before publication.

The revision's `project-manifest.json` records `incremental.reusedFiles`, `incremental.processedFiles` and `incremental.reusedSymbolFlows`; the first two are also printed by `live-scan`. A change to `maxLines` triggers a full re-analysis. Existing v0.6 bundles lacking reusable indexes safely fall back to analysis on the next changed revision.

A **fail-closed filesystem writer lock** prevents two concurrent scanners or a rollback racing to publish. In the event of a crashed owner, a stale `.writer.lock` requires explicit operator inspection and removal; it is never silently stolen.

**Historical v0.7 limitation (fixed in v0.8):** file metadata, not a content hash, previously determined changes. Source files deliberately edited while preserving size/mtime/ctime/inode could bypass detection. The v0.8 source-stability gate checks both metadata and content hashes. The project graph and archive checksum verification are still whole-revision operations, so large Godot Engine checkouts remain CPU/disk intensive. Old bundles are retained unless v0.8 retention is explicitly enabled; this is **per-file processing reuse**, not an incremental Godot compiler. The CLI does not run Godot/C++ code or hot-swap live flows.

## v0.6: Tinner Live — unattended graph revisions (no AI)

Run on a trusted local workstation, **outside** the source tree:

```sh
# Export initial revision or update an existing Tinner Live directory:
tinner live-scan ./godot-game ./tinner-live
# Then repeatedly check for changes and publish validated revisions:
tinner live-watch ./godot-game ./tinner-live 15000
# From a second shell:
tinner live-status ./tinner-live
tinner live-rollback ./tinner-live
tinner live-resume ./tinner-live
```

- The state directory is **new or already initialized by Tinner Live**, and is pinned to the canonical input directory. No source file is modified.
- It contains `state.json` plus `revisions/rev-.../` (complete, immutable Godot bundles) and an atomically published `current.json` pointer. All graph files are only *metadata*, never executable code.
- The watcher polls portable file metadata (path, size, mtime, ctime, inode and device) and skips when unchanged. When a change is detected, it builds a fresh **complete revision** reusing unchanged files where possible, verifies source/chunk/generated-graph checksums, checks that source metadata stayed stable while building, and only then publishes the new pointer. A failed candidate never replaces the current revision; errors are reported and retried on the next poll.
- If you roll back, the prior verified revision becomes active and updates are **paused** until `live-resume` is explicitly invoked. Restarting the watcher will not cancel that pause.
- Live mode does **not** update executing Adamantium-node flows, deploy Godot projects, compile C++, run the Godot engine, or call any neural network or remote API.
- **Resource caveat:** each revision still verifies the **complete** project and retains prior full bundles without automatic pruning. Unchanged sources are reused, but graph-level metadata and dependency relationships are regenerated. Large Godot Engine checkouts may require considerable disk, CPU, and time. Use a small project first.
- In v0.8, each polling pass computes SHA-256 over the source tree. This is more reliable than timestamp checks but costs disk I/O.
- Node-RED editor registration is still installation-dependent: v0.6's watcher is a local CLI process, not a verified MAS background job. Run it with an operator-owned process supervisor if persistence across reboots is needed.

Tinner is a small, **AI-free** Node-RED / [Adamantium-node](https://github.com/Garyu-tt/adamantium-node) plugin and CLI. It converts a Godot **project folder** into source chunks (at most 2,000 lines apiece), an importable static file-reference graph, and a checksum-verifiable archive. The input project or Godot engine source tree is never changed.

## v0.4: Godot game projects **and Godot Engine source** (no model / API calls)

Tinner automatically identifies **two** inputs: a Godot game project (root `project.godot`) and a **Godot Engine source checkout** (root `SConstruct` with `core/` and `scene/`). No model or external AI calls are used. Run once, unattended:

```sh
node bin/tinner.js project ./my-godot-project ./tinner-bundle
# Or: Godot's C++ engine repository (a separate bundle)
node bin/tinner.js project ./godot-engine ./godot-engine-bundle
node bin/tinner.js project-verify ./tinner-bundle
node bin/tinner.js project-restore ./tinner-bundle ./restored-godot-project
```

The destination must **not** exist yet and must be **outside the input project**. On completion:
- `project-manifest.json`: project kind, all paths, SHA-256, bytes, language, per-chunk boundaries, direct path references and unresolved references;
- `project-flow.json`: importable file dependency graph for Adamantium-node / Node-RED using inert `tinner-project-module` palette nodes;
- `chunks/<relative-project-path>/part-NNNN.txt`: text files split into ≤2,000 physical lines, preserving exact UTF-8 and original newline conventions;
- `flows/<relative-project-code-path>.json`: importable source-chunk flow for each supported code file (e.g. `.gd`), including checksum join;
- `assets/<relative-project-path>`: binary assets copied byte-for-byte, including e.g. images, audio, fonts;
- adjacent `*.import` metadata is treated as text and preserved. The Godot 4 `.godot/` cache, Git internals `.git/` and `node_modules/` are intentionally skipped.

**No execution or code rewriting.** Dependency graph nodes are read-only metadata; connection wires do not propagate messages or run user programs. GDScript top-level boundary detection is a conservative lexical heuristic (not a complete parser), which does not split known triple-quoted strings or top-level function bodies when another good cut fits. Constructs exceeding 2,000 lines still get a hard line cut, explicitly marked `line-limit`. Unsupported languages get a fixed-line cut. Tinner will never claim the resulting fragments are independently runnable. Restoring the project recreates the original sources and binary assets (except excluded generated caches). Cross-file dependencies are discovered from *static path literals only* (`res://...`, scene `ext_resource` paths and C/C++ quoted `#include` candidates); `uid://` resolution, dynamically constructed paths, editor script execution and full Godot import validation are **not** yet implemented.

### Safety and scope

- One command, deterministic filesystem work. **No ChatGPT, other LLMs, AI provider keys, or external services required** after installation.
- Designed as a small proof-of-concept, not a safe sandbox for executing third-party Godot projects. No Godot executable is launched.
- Symlinks and unsupported filesystem entries are rejected, not silently followed. Archives cannot write outside a fresh restore directory; existing destinations are refused. File hashes are checked before restoration.
- Input must contain Godot project markers (`project.godot` or `SConstruct` with `core/` and `scene/`). Text must be valid UTF-8. Default per-text-file read limit 16 MiB; larger text files cause an explicit error. Binary assets are copied without that line limit, with streaming SHA-256 hashes instead of loading all bytes into RAM.
- Graph export may include sensitive paths and source code in fragment flows. Treat the bundle as source code, not a public report.
- Generated project structure is **not** a transformed executable Godot application; it is a faithful *archival decomposition + visualization*. Future AST/compiler adapters can add proven behavioral transformation.
- Existing Node-RED nodes remain opt-in; no modifications to the fork or host settings.

## Palette nodes

- `tinner`: accepts a UTF-8 file in `msg.payload`; outputs `msg.payload.flow` and `msg.payload.manifest`;
- `tinner-chunk`: editable stored source text, does not execute it;
- `tinner-join`: SHA-256 and source reconstruction;
- `tinner-project-module`: inert Godot project dependency-node, no execution or forwarding.

Install in the Adamantium-node user directory:

```sh
npm install git+https://github.com/Garyu-tt/tinner.git
```

A runtime restart may be necessary to register the palette. Server installation and the real Godot binary integration have **not** been validated yet.

## Previous single-file mode

```sh
node bin/tinner.js split ./example.js ./tinner-out
node bin/tinner.js verify ./tinner-out
node bin/tinner.js join ./tinner-out ./restored-example.js
```

JavaScript uses Acorn top-level statement boundaries; Godot GDScript uses the conservative lexical detector; other languages remain lossless textual chunks.


## v0.5: Static symbol and port graph, automatically generated

An ordinary `tinner project <source> <new-bundle>` run now also writes:

- `symbol-graph.json`: a stable, inert index of recognized GDScript functions and narrow C/C++ definitions, with source ranges, parameter type hints, return type hints and possible same-file direct-call edges.
- `flows/symbols/<relative-source-path>.json`: an importable Adamantium-node / Node-RED `tinner-symbol` node graph per source file. Its `ports` property describes typed metadata; the actual Node-RED node still has one standard input and output and deliberately never forwards messages.
- `project-manifest.json.generatedArtifacts`: checksums covering the generated graph files. `project-verify` checks these as well as source chunks and binary assets.

Generated graph IDs and JSON are reproducible across repeated exports of an unchanged project, scoped to a project namespace (mode and source-folder name by default). If two different projects share that same namespace, import their graphs separately to avoid node-ID collisions. The library API supports an explicit namespace override.

All indexing is **local and deterministic**: no LLM, model provider, network connection or project-code execution. The Godot project is never rewritten. Static extraction is incomplete by design: GDScript supports a subset of declaration syntax; C++ indexing recognizes a conservative subset of ordinary function definitions, not templates/macros/full C++ grammar. Edges are only **possible** direct same-file calls and carry `confidence: "heuristic"`; missing or ambiguous relationships are deliberately omitted. Types are hints, not proven signatures and **not runnable ports**. Unsupported features stay visible as absent metadata instead of being invented.

For true runnable flow transformations, the future pipeline needs a real Godot/GDScript parser and a C++ compiler or AST-backed adapter, dependency injection/ABI mapping, a sandboxed test build, and explicit acceptance gates. Tinner v0.5 lays the inspectable structural groundwork, **not** a runnable Godot rewrite.

## Tests

```sh
npm install --ignore-scripts
npm test
npm run check
```

Godot Engine C++ mode preserves and visualizes original files; it **does not** parse C++ into compilable 2,000-line modules or rebuild the engine. C++ includes are best-effort static references. This is a **decomposition and inspection milestone**, not a new engine binary.

The project deliberately has a small runtime dependency surface (`acorn` for JavaScript parsing) and does not require any AI service.
