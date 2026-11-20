# Tinner — Adamantium-node palette plugin

Small, **non-destructive microexperiment**: split UTF-8 code into blocks capped at 2,000 lines and turn them into editable source-text nodes in an importable [Adamantium-node](https://github.com/Garyu-tt/adamantium-node) / Node-RED flow. A manifest and SHA-256 checks ensure the original file can be reconstructed byte-for-byte **for valid UTF-8 input**.

## What v0.2 adds

For plain JavaScript (`.js`, `.mjs`, `.cjs`), Tinner uses **Acorn AST analysis** to *prefer* cuts after complete top-level statements, functions or classes, when a boundary fits within the line limit. It does not rewrite code, imports, references, control flow or function bodies.

If an individual construct exceeds 2,000 lines, no suitable cut exists, or the source cannot be parsed, Tinner falls back to a strict line cut and records `splitReason: "line-limit"` or `analysis.status: "fallback"` in `manifest.json`. Any chunk can be incomplete or non-executable. TypeScript and other languages continue using exact textual splitting.

**Important:** Tinner only preserves the original program when chunks are *reassembled in order*. The generated `tinner-chunk` nodes are text holders, **not directly executable source modules**, and the plugin does not modify the application or run arbitrary supplied code.

## Install

From your Node-RED user directory on a trusted system:

```sh
npm install git+https://github.com/Garyu-tt/tinner.git
```

Then restart your Adamantium-node / Node-RED runtime so the three palette nodes are registered.

## CLI

```sh
node bin/tinner.js split ./example.js ./tinner-out [max-lines]
node bin/tinner.js verify ./tinner-out
node bin/tinner.js join ./tinner-out ./restored-example.js
```

The destination output directory/file must not already exist. `split` generates `manifest.json`, `chunks/part-NNNN.txt` and `flow.json`. Import `flow.json` in the editor, then inject **Reassemble**.

## Nodes

- `tinner`: accepts source in `msg.payload` and optional `msg.filename`, emits `msg.payload.flow` and `msg.payload.manifest`. Set **JS boundaries** to prefer semantic AST boundaries; disable it to use fixed-line splitting.
- `tinner-chunk`: source text in an editor field; passes the part through as data.
- `tinner-join`: verifies chunk hashes and original checksum, emits the restored source.

Editing a chunk invalidates the original hashes. This is intentional: edits aren't silently accepted as the original.

## Constraints

- Current input: one file at a time, no whole-repository dependency graph.
- No support yet for moving functions into independent modules, changing import statements or hot-swapping executed application code.
- No hard-coded Adamantium-node capabilities or host addresses. Uses the baseline Node-RED node ABI while custom capability APIs remain unverified.
- Source code can contain secrets. Imported flows may store that code in plaintext: review before sharing or deploying.
- SHA-256 detects corruption, it does not authenticate origin.
- Intended for valid UTF-8. Non-UTF-8 data is out of scope.

## Tests

```sh
npm install --ignore-scripts
npm test
npm run check
```

Node.js 18+ for this plugin. CI uses Node.js 20.
