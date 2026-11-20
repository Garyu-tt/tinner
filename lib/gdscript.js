'use strict';

/**
 * A conservative lexical boundary detector for Godot GDScript.
 * This deliberately does not pretend to be a full GDScript parser.
 * It only identifies new root-level declarations while outside strings,
 * comments, bracket continuations and triple-quoted strings.
 */
const DECLARATION = /^(?:@[\w.]+(?:\s|\(|$)|(?:static\s+)?func\s+|(?:class|class_name|extends|var|const|signal|enum)\b)/;

function analyzeGDScript(_source, sourceLines) {
  const cuts = [];
  let triple = null;
  let bracketDepth = 0;
  let continuation = false;
  let previousWasDecorator = false;
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i].replace(/\r\n|\r|\n$/, '');
    const clean = line.trim();
    const topLevel = !triple && bracketDepth === 0 && !continuation &&
      line.length > 0 && !/^\s/.test(line) && DECLARATION.test(line);
    const decorator = topLevel && line.startsWith('@');
    if (topLevel && i > 0 && !previousWasDecorator) cuts.push(i);
    if (topLevel) previousWasDecorator = decorator;
    else if (clean && !clean.startsWith('#') && !triple) previousWasDecorator = false;

    let quote = null;
    let escaped = false;
    let effective = '';
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (triple) {
        if (line.startsWith(triple, j)) { j += 2; triple = null; }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '#') break;
      if ((ch === '"' || ch === "'") && line.slice(j, j+3) === ch.repeat(3)) {
        triple = ch.repeat(3); j += 2; continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if ('([{'.includes(ch)) bracketDepth++;
      if (')]}'.includes(ch)) bracketDepth--;
      if (bracketDepth < 0) return { status:'fallback', reason:'unbalanced-gdscript-brackets', boundaries:[] };
      effective += ch;
    }
    continuation = !triple && /\\\s*$/.test(effective);
  }
  if (triple || bracketDepth !== 0) return {status:'fallback',reason:'unclosed-gdscript-construct',boundaries:[]};
  return {status:'analyzed',parser:'gdscript-lexical',boundaries:[...new Set(cuts)].sort((a,b)=>a-b)};
}

module.exports={analyzeGDScript};
