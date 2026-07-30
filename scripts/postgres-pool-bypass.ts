import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface PostgresPoolBypass {
  relativePath: string;
  line: number;
  column: number;
}

const TEST_FILE = /(?:\.test|\.spec|\.integration\.test)\.[cm]?tsx?$/;
const SHARED_FACTORY = 'packages/postgres-runtime/src/index.ts';
const LIFECYCLE_SCRIPTS = ['scripts/helm-tenant-cutover.ts', 'scripts/compose-tenant-cutover.ts'];

function posixPath(path: string): string {
  return path.split(sep).join('/');
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.[cm]?tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function candidateFiles(root: string): string[] {
  const files: string[] = [];
  for (const workspace of ['apps', 'packages']) {
    const directory = join(root, workspace);
    let packages: ReturnType<typeof readdirSync>;
    try {
      packages = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of packages) {
      if (entry.isDirectory()) {
        files.push(...sourceFiles(join(directory, entry.name, 'src')));
      }
    }
  }
  for (const script of LIFECYCLE_SCRIPTS) {
    const path = join(root, script);
    try {
      readFileSync(path);
      files.push(path);
    } catch {
      // Lifecycle scripts enter the inventory when they are created.
    }
  }
  return files.sort();
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isPgModuleCall(expression: ts.Expression): boolean {
  const current = unwrap(expression);
  if (!ts.isCallExpression(current) || current.arguments.length !== 1) {
    return false;
  }
  const argument = current.arguments[0];
  if (!ts.isStringLiteral(argument) || argument.text !== 'pg') {
    return false;
  }
  return (
    (ts.isIdentifier(current.expression) && current.expression.text === 'require') ||
    current.expression.kind === ts.SyntaxKind.ImportKeyword
  );
}

function isPgPoolMember(expression: ts.Expression): boolean {
  const current = unwrap(expression);
  return (
    ts.isPropertyAccessExpression(current) &&
    current.name.text === 'Pool' &&
    isPgModuleCall(current.expression)
  );
}

function collectPgBindings(source: ts.SourceFile): { pools: Set<string>; namespaces: Set<string> } {
  const pools = new Set<string>();
  const namespaces = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'pg'
    ) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.add(clause.namedBindings.name.text);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === 'Pool') {
            pools.add(element.name.text);
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isIdentifier(node.name)) {
        if (isPgPoolMember(initializer)) pools.add(node.name.text);
        if (isPgModuleCall(initializer)) namespaces.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name) && isPgModuleCall(initializer)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(imported) &&
            imported.text === 'Pool' &&
            ts.isIdentifier(element.name)
          ) {
            pools.add(element.name.text);
          }
        }
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const initializer = unwrap(node.right);
      if (isPgPoolMember(initializer)) pools.add(node.left.text);
      if (isPgModuleCall(initializer)) namespaces.add(node.left.text);
    }

    ts.forEachChild(node, visit);
  }
  visit(source);
  return { pools, namespaces };
}

function scanFile(root: string, file: string): PostgresPoolBypass[] {
  const relativePath = posixPath(relative(root, file));
  if (relativePath === SHARED_FACTORY || TEST_FILE.test(relativePath)) {
    return [];
  }
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const { pools, namespaces } = collectPgBindings(source);
  const findings: PostgresPoolBypass[] = [];

  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      const constructor = unwrap(node.expression);
      const directPool = ts.isIdentifier(constructor) && pools.has(constructor.text);
      const namespacePool =
        ts.isPropertyAccessExpression(constructor) &&
        constructor.name.text === 'Pool' &&
        ts.isIdentifier(constructor.expression) &&
        namespaces.has(constructor.expression.text);
      if (directPool || namespacePool || isPgPoolMember(constructor)) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({
          relativePath,
          line: location.line + 1,
          column: location.character + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

export function scanPostgresPoolBypasses(root: string): PostgresPoolBypass[] {
  return candidateFiles(resolve(root)).flatMap((file) => scanFile(resolve(root), file));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = scanPostgresPoolBypasses(process.cwd());
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `${finding.relativePath}:${finding.line}:${finding.column}: direct pg.Pool construction`,
      );
    }
    process.exitCode = 1;
  }
}
