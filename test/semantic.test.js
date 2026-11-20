'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSource, joinSource } = require('../lib/tinner');

const fn = (name, lineCount) =>
  'function ' + name + '() {\n' +
  Array.from({length:lineCount - 2},(_,i)=>'  void '+i+';\n').join('') +
  '}\n';

test('JS function boundaries preferred to line limit', () => {
  const source=fn('a',20)+fn('b',20)+fn('c',20);
  const result=splitSource(source,{filename:'demo.js',maxLines:25});
  assert.equal(result.manifest.analysis.status,'analyzed');
  assert.equal(result.manifest.analysis.parser,'acorn');
  assert.deepEqual(result.chunks.map(c=>c.lineCount),[20,20,20]);
  assert.deepEqual(result.chunks.map(c=>c.splitReason),['top-level-statement','top-level-statement','end-of-file']);
  assert.equal(joinSource(result.manifest,result.chunks),source);
});

test('JavaScript parse error falls back to fixed lines without data loss', () => {
  const source='function broken( {\n  } \n  ???\n';
  const result=splitSource(source,{filename:'broken.js',maxLines:2});
  assert.equal(result.manifest.analysis.status,'fallback');
  assert.equal(result.manifest.analysis.reason,'unparseable-js');
  assert.deepEqual(result.chunks.map(c=>c.lineCount),[2,1]);
  assert.equal(joinSource(result.manifest,result.chunks),source);
});

test('Unsupported language and manual opt-out both remain lossless', () => {
  const source='hello\nworld\n! \n';
  const py=splitSource(source,{filename:'file.py',maxLines:2});
  const js=splitSource(source,{filename:'file.js',semantic:false,maxLines:2});
  assert.equal(py.manifest.analysis.status,'not-applicable');
  assert.equal(js.manifest.analysis.status,'disabled');
  assert.equal(joinSource(py.manifest,py.chunks),source);
  assert.equal(joinSource(js.manifest,js.chunks),source);
});

test('Oversized single function gets capped, with explicit line-limit warning metadata', () => {
  const source=fn('huge',51)+'const x = 1;\n';
  const result=splitSource(source,{filename:'large.cjs',maxLines:20});
  assert.ok(result.chunks.every(c=>c.lineCount<=20));
  assert.equal(result.chunks[0].splitReason,'line-limit');
  assert.equal(result.manifest.analysis.syntax,'script');
  assert.equal(joinSource(result.manifest,result.chunks),source);
});

test('AST cuts do not split two statements occurring on one line', () => {
  const source='let a=1;let b=2;\n'+fn('next',5)+'let c=3;\n';
  const r=splitSource(source,{filename:'sample.mjs',maxLines:3});
  assert.equal(r.chunks[0].lineCount,1);
  assert.equal(r.chunks[0].source,'let a=1;let b=2;\n');
  assert.equal(r.chunks[0].splitReason,'top-level-statement');
  assert.equal(joinSource(r.manifest,r.chunks),source);
});

test('AST analysis never executes user source',()=>{
  const source='globalThis.__TINNER_TEST_SHOULD_NOT_EXECUTE__ = true;\n';
  const r=splitSource(source,{filename:'x.js'});
  assert.notEqual(globalThis.__TINNER_TEST_SHOULD_NOT_EXECUTE__,true);
  assert.equal(joinSource(r.manifest,r.chunks),source);
});
