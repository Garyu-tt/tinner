'use strict';

const acorn = require('acorn');

/**
 * Suggest safe *textual* cut positions after top-level JavaScript statements.
 * No transformation of the AST or the executable source is performed.
 */
function analyzeBoundaries(source, sourceLines, filename = '') {
  const type = filename.toLowerCase().endsWith('.cjs') ? 'script' : 'module';
  let ast;
  let syntax = type;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: type, locations: true, allowHashBang: true });
  } catch (first) {
    if (type === 'module') {
      try {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true });
        syntax = 'script';
      } catch (second) {
        return { status: 'fallback', reason: 'unparseable-js', boundaries: [], detail: second.message };
      }
    } else {
      return { status: 'fallback', reason: 'unparseable-js', boundaries: [], detail: first.message };
    }
  }
  const boundaries = [];
  for (const statement of ast.body) {
    const endLine = statement.loc.end.line;
    const column = statement.loc.end.column;
    // A statement finishing halfway through a physical line is NOT a safe cut.
    const line = sourceLines[endLine - 1] || '';
    const lineContent = line.replace(/\r\n|\r|\n$/, '');
    if (endLine >= 1 && endLine < sourceLines.length &&
        lineContent.slice(column).trim() === '') {
      boundaries.push(endLine);
    }
  }
  return {
    status: 'analyzed',
    parser: 'acorn',
    syntax,
    boundaries: [...new Set(boundaries)].sort((a, b) => a - b)
  };
}

module.exports = { analyzeBoundaries };
