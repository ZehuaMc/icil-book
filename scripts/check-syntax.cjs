// Dependency-free syntax validation using an explicitly provided TypeScript compiler installation.
const fs = require('node:fs');
const path = require('node:path');
const compiler = process.env.TYPESCRIPT_COMPILER || require.resolve('typescript');
const ts = require(compiler);
let count = 0, failures = 0;
function walk(dir) {
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(full)) {
      count++;
      const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, full.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const d of source.parseDiagnostics) { failures++; const pos = source.getLineAndCharacterOfPosition(d.start || 0); console.error(`${full}:${pos.line + 1}:${pos.character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`); }
    }
  }
}
for (const dir of ['src', 'tests', 'e2e', 'prisma']) walk(dir);
for (const file of ['next.config.ts', 'playwright.config.ts']) {
  count++;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const d of source.parseDiagnostics) { failures++; console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); }
}
console.log(`Parsed ${count} TypeScript/TSX files; ${failures} syntax errors. This does not replace typechecking.`);
process.exitCode = failures ? 1 : 0;
