# Tinner — deterministic Adamantium-node project slicer

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

## Tests

```sh
npm install --ignore-scripts
npm test
npm run check
```

Godot Engine C++ mode preserves and visualizes original files; it **does not** parse C++ into compilable 2,000-line modules or rebuild the engine. C++ includes are best-effort static references. This is a **decomposition and inspection milestone**, not a new engine binary.

The project deliberately has a small runtime dependency surface (`acorn` for JavaScript parsing) and does not require any AI service.
