# Tinner — Adamantium-node plugin (microexperiment)

Tinner is an independent Node-RED palette package for [Adamantium-node](https://github.com/Garyu-tt/adamantium-node). It splits UTF-8 source files into text chunks of at most 2,000 lines, produces an importable code-node graph, and verifies exact reconstruction using SHA-256.

**Scope:** lossless textual splitting and assembly, not semantic refactoring of executable functions. Chunks are inert source text.

## Install

In the Node-RED user directory: `npm install /path/to/tinner`, then restart Adamantium-node.

## CLI

```sh
node bin/tinner.js split ./example.js ./tinner-out
node bin/tinner.js verify ./tinner-out
node bin/tinner.js join ./tinner-out ./restored-example.js
```

The output directory must not exist beforehand. It contains `manifest.json`, `chunks/part-NNNN.txt` and importable `flow.json`.

## Flow

Import `flow.json` in the Node-RED editor and click **Reassemble**. Flow structure: `inject → tinner-chunk × N → tinner-join → debug`. Every chunk is a separately editable code node, and the join node verifies the original SHA-256. Or send source text as `msg.payload` to the **tinner split** node; it emits `msg.payload.flow` and `msg.payload.manifest`.

## Limits

- UTF-8 textual source only; one input file per run.
- Generated chunks do not execute independently, and Tinner never evaluates the code.
- No hard-coded MAS addresses or requirements for optional Adamantium-node extensions.
- Hash comparison is for integrity, not trusted-source authentication.
- Do not export secrets into shared flows.

Run `npm test` (Node.js 18+).
