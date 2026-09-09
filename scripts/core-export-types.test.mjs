import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.join(root, 'packages/core/tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const surfaces = program
  .getSourceFiles()
  .filter(
    (file) =>
      file.fileName.startsWith(path.join(root, 'packages/core/src/')) &&
      (file.fileName.endsWith('/index.ts') || file.fileName.endsWith('/ultimateFramework.ts')),
  );

test('public barrels explicitly mark type-only named exports for raw ESM', () => {
  const invalid = [];
  for (const file of surfaces) {
    for (const statement of file.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      )
        continue;
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        let symbol = checker.getSymbolAtLocation(element.name);
        if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (
          symbol &&
          symbol.flags & ts.SymbolFlags.Type &&
          !(symbol.flags & ts.SymbolFlags.Value)
        ) {
          invalid.push(`${path.relative(root, file.fileName)}: ${element.name.text}`);
        }
      }
    }
  }
  assert.deepEqual(invalid, []);
});

test('the public IM store remains a runtime class export', () => {
  for (const relative of ['packages/core/src/index.ts', 'packages/core/src/im/index.ts']) {
    const file = program.getSourceFile(path.join(root, relative));
    const module = checker.getSymbolAtLocation(file);
    const exported = checker
      .getExportsOfModule(module)
      .find((symbol) => symbol.name === 'InMemoryIMContextStore');
    assert.ok(exported, `${relative} must export InMemoryIMContextStore`);
    assert.ok(checker.getAliasedSymbol(exported).flags & ts.SymbolFlags.Class);
  }
});
