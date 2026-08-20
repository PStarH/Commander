import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';

export interface ScannerWarning {
  severity: string;
  category: string;
  message: string;
  evidence: string;
  sourceFingerprint?: string;
}

export interface ScannerPolicyAuditWarning {
  fingerprint: string;
  severity: string;
  category: string;
  message: string;
}

export interface ScannerPolicyViolation extends ScannerPolicyAuditWarning {
  reason: 'new_high_warning' | 'duplicate_high_warning' | 'malware_or_critical';
}

export function warningFingerprint(warning: ScannerWarning): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        severity: warning.severity,
        category: warning.category,
        message: warning.message,
        evidenceSha256: createHash('sha256').update(warning.evidence).digest('hex'),
      }),
    )
    .digest('hex');
}

function isMalwareOrCritical(warning: ScannerWarning): boolean {
  return warning.severity === 'critical' || warning.category.startsWith('malware.');
}

function isHighWarning(warning: ScannerWarning): boolean {
  return warning.severity === 'high';
}

function auditWarning(warning: ScannerWarning): ScannerPolicyAuditWarning {
  return {
    fingerprint: warningFingerprint(warning),
    severity: warning.severity,
    category: warning.category,
    message: warning.message,
  };
}

const MAX_HIGH_WARNING_OCCURRENCES = 1_024;

function warningEvidencePrefix(evidence: string): string {
  return evidence.endsWith('...') ? evidence.slice(0, -3) : evidence;
}

const KNOWN_GLOBAL_IDENTIFIERS = new Set([
  'Buffer',
  'Infinity',
  'NaN',
  '__dirname',
  '__filename',
  'console',
  'globalThis',
  'process',
  'require',
  'undefined',
]);

function nodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  let result: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    const start = node.getStart(sourceFile);
    if (position < start || position >= node.getEnd()) return;
    result = node;
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return result;
}

type ExecutableFunction =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

function isExecutableFunction(node: ts.Node): node is ExecutableFunction {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    node.body !== undefined
  );
}

function enclosingFunction(node: ts.Node): ExecutableFunction | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (isExecutableFunction(current)) return current;
  }
  return undefined;
}

function enclosingTopLevelStatement(node: ts.Node): ts.Statement | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isStatement(current) && ts.isSourceFile(current.parent)) return current;
  }
  return undefined;
}

function enclosingCall(node: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) return current;
  }
  return undefined;
}

function bindingElementForName(
  bindingName: ts.BindingName,
  name: string,
): ts.BindingElement | undefined {
  if (ts.isIdentifier(bindingName)) return undefined;
  for (const element of bindingName.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name) && element.name.text === name) return element;
    const nested = bindingElementForName(element.name, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function declarationForName(
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
  name: string,
): ts.Declaration | undefined {
  if (ts.isIdentifier(declaration.name)) {
    return declaration.name.text === name ? declaration : undefined;
  }
  return bindingElementForName(declaration.name, name);
}

function bindingOwnerDeclaration(
  binding: ts.BindingElement,
): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  for (let current: ts.Node | undefined = binding; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) || ts.isParameter(current)) return current;
  }
  return undefined;
}

function declarationFromStatements(
  sourceFile: ts.SourceFile,
  statements: ts.NodeArray<ts.Statement>,
  name: string,
  position: number,
): ts.Declaration | undefined {
  let result: ts.Declaration | undefined;
  for (const statement of statements) {
    const startsBeforeReference = statement.getStart(sourceFile) < position;
    if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const clause = statement.importClause;
      if (clause.name?.text === name) result = clause;
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
        result = bindings;
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        const specifier = bindings.elements.find((element) => element.name.text === name);
        if (specifier !== undefined) result = specifier;
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      result = statement;
      continue;
    }
    if (!startsBeforeReference) continue;
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      result = statement;
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const match = declarationForName(declaration, name);
      if (match !== undefined) result = match;
    }
  }
  return result;
}

function findLocalDeclaration(
  sourceFile: ts.SourceFile,
  identifier: ts.Identifier,
): ts.Declaration | undefined {
  const name = identifier.text;
  const position = identifier.getStart(sourceFile);
  for (let scope: ts.Node | undefined = identifier; scope; scope = scope.parent) {
    if (ts.isVariableDeclaration(scope) && ts.isVariableDeclarationList(scope.parent)) {
      for (const declaration of scope.parent.declarations) {
        if (declaration.getStart(sourceFile) >= position) break;
        const match = declarationForName(declaration, name);
        if (match !== undefined) return match;
      }
    }
    if (ts.isCatchClause(scope)) {
      const variableDeclaration = scope.variableDeclaration;
      if (variableDeclaration !== undefined) {
        const match = declarationForName(variableDeclaration, name);
        if (match !== undefined) return match;
      }
    }
    if (ts.isForStatement(scope) && scope.initializer !== undefined) {
      if (ts.isVariableDeclarationList(scope.initializer)) {
        const declaration = scope.initializer.declarations.find(
          (candidate) => declarationForName(candidate, name) !== undefined,
        );
        if (declaration !== undefined) return declarationForName(declaration, name);
      }
    }
    if (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
      if (ts.isVariableDeclarationList(scope.initializer)) {
        const declaration = scope.initializer.declarations.find(
          (candidate) => declarationForName(candidate, name) !== undefined,
        );
        if (declaration !== undefined) return declarationForName(declaration, name);
      }
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      const declaration = declarationFromStatements(sourceFile, scope.statements, name, position);
      if (declaration !== undefined) return declaration;
    }
    if (isExecutableFunction(scope)) {
      const parameter = scope.parameters.find(
        (candidate) => declarationForName(candidate, name) !== undefined,
      );
      if (parameter !== undefined) return declarationForName(parameter, name);
    }
  }
  return undefined;
}

function isReferencedIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (ts.isQualifiedName(parent) && parent.right === identifier) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  return true;
}

function referencedIdentifiers(node: ts.Node): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && isReferencedIdentifier(current)) references.push(current);
    current.forEachChild(visit);
  };
  visit(node);
  return references;
}

function assignmentTargetIdentifiers(node: ts.Node): ts.Identifier[] {
  if (ts.isIdentifier(node)) return [node];
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return referencedIdentifiers(node.expression);
  }
  return referencedIdentifiers(node);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

interface DependencyWrite {
  text: string;
  inputs: ts.Identifier[];
  position: number;
}

function writesToDeclaration(
  sourceFile: ts.SourceFile,
  declaration: ts.Declaration,
  beforePosition: number,
): DependencyWrite[] {
  const writes: DependencyWrite[] = [];
  const sameDeclaration = (identifier: ts.Identifier): boolean =>
    findLocalDeclaration(sourceFile, identifier) === declaration;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) >= beforePosition) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      if (assignmentTargetIdentifiers(node.left).some(sameDeclaration)) {
        writes.push({
          text: node.getText(sourceFile),
          inputs: referencedIdentifiers(node.right),
          position: node.getStart(sourceFile),
        });
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetIdentifiers(node.operand).some(sameDeclaration)
    ) {
      writes.push({
        text: node.getText(sourceFile),
        inputs: [],
        position: node.getStart(sourceFile),
      });
    } else if (
      ts.isDeleteExpression(node) &&
      assignmentTargetIdentifiers(node.expression).some(sameDeclaration)
    ) {
      writes.push({
        text: node.getText(sourceFile),
        inputs: [],
        position: node.getStart(sourceFile),
      });
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return writes.sort((left, right) => left.position - right.position);
}

function declarationText(sourceFile: ts.SourceFile, declaration: ts.Declaration): string {
  if (
    ts.isImportClause(declaration) ||
    ts.isImportSpecifier(declaration) ||
    ts.isNamespaceImport(declaration)
  ) {
    for (let current: ts.Node = declaration; current.parent; current = current.parent) {
      if (ts.isImportDeclaration(current)) return current.getText(sourceFile);
    }
  }
  if (ts.isBindingElement(declaration)) {
    const owner = bindingOwnerDeclaration(declaration);
    if (owner !== undefined) return owner.getText(sourceFile);
  }
  return declaration.getText(sourceFile);
}

function bindingInitializerInputs(binding: ts.BindingElement): ts.Identifier[] {
  const inputs: ts.Identifier[] = [];
  for (let current: ts.Node | undefined = binding; current; current = current.parent) {
    if (ts.isBindingElement(current) && current.initializer !== undefined) {
      inputs.push(...referencedIdentifiers(current.initializer));
    }
    if (ts.isVariableDeclaration(current) || ts.isParameter(current)) {
      if (current.initializer !== undefined) {
        inputs.push(...referencedIdentifiers(current.initializer));
      }
      return inputs;
    }
  }
  return inputs;
}

function declarationInputs(declaration: ts.Declaration): ts.Identifier[] {
  if (ts.isBindingElement(declaration)) {
    return bindingInitializerInputs(declaration);
  }
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isParameter(declaration) ||
    ts.isPropertyDeclaration(declaration)
  ) {
    return declaration.initializer === undefined
      ? []
      : referencedIdentifiers(declaration.initializer);
  }
  return [];
}

function collectDependencyClosure(
  sourceFile: ts.SourceFile,
  roots: readonly ts.Identifier[],
  beforePosition: number,
): string[] | undefined {
  const entries: string[] = [];
  const visited = new Set<ts.Declaration>();

  const resolve = (identifier: ts.Identifier): boolean => {
    if (KNOWN_GLOBAL_IDENTIFIERS.has(identifier.text)) return true;
    const declaration = findLocalDeclaration(sourceFile, identifier);
    if (declaration === undefined) return false;
    if (visited.has(declaration)) return true;
    visited.add(declaration);

    entries.push('declaration:' + declarationText(sourceFile, declaration));
    const writes = writesToDeclaration(sourceFile, declaration, beforePosition);
    for (const write of writes) entries.push('write:' + write.text);
    return [...declarationInputs(declaration), ...writes.flatMap((write) => write.inputs)].every(
      resolve,
    );
  };

  return roots.every(resolve) ? entries.sort() : undefined;
}

function stableBindingIdentity(
  node: ExecutableFunction,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name?.text;
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name.getText(sourceFile);
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isFunctionExpression(node) && node.name !== undefined) return node.name.text;

  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return 'variable:' + parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return 'property:' + parent.name.getText(sourceFile);
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const index = parent.arguments?.findIndex((argument) => argument === node) ?? -1;
    if (index >= 0) return 'argument:' + index + ':' + parent.expression.getText(sourceFile);
  }
  return undefined;
}

function classIdentity(
  node: ts.ClassDeclaration | ts.ClassExpression,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (node.name !== undefined) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return 'variable:' + node.parent.name.text;
  }
  return undefined;
}

function lexicalScopeIdentity(
  sourceFile: ts.SourceFile,
  scope: ExecutableFunction,
): string[] | undefined {
  const identities: string[] = [];
  for (let current: ts.Node | undefined = scope; current; current = current.parent) {
    if (isExecutableFunction(current)) {
      const body = current.body;
      if (body === undefined) return undefined;
      const binding = stableBindingIdentity(current, sourceFile);
      if (binding === undefined) return undefined;
      identities.push(
        'function:' +
          current.kind +
          ':' +
          binding +
          ':' +
          sourceFile.text.slice(current.getStart(sourceFile), body.getStart(sourceFile)),
      );
    } else if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      const identity = classIdentity(current, sourceFile);
      if (identity === undefined) return undefined;
      identities.push('class:' + identity);
    } else if (ts.isModuleDeclaration(current)) {
      identities.push('module:' + current.name.getText(sourceFile));
    }
  }
  return identities.reverse();
}

function containsNode(container: ts.Node, node: ts.Node): boolean {
  return container.pos <= node.pos && container.end >= node.end;
}

function controlFlowDependencies(
  sourceFile: ts.SourceFile,
  call: ts.CallExpression | ts.NewExpression,
  boundary: ts.Node,
): { descriptors: string[]; roots: ts.Identifier[] } {
  const descriptors: string[] = [];
  const roots: ts.Identifier[] = [];
  for (
    let current: ts.Node | undefined = call.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    let expression: ts.Expression | undefined;
    let branch = '';
    if (ts.isIfStatement(current)) {
      expression = current.expression;
      branch = containsNode(current.expression, call)
        ? 'condition'
        : containsNode(current.thenStatement, call)
          ? 'then'
          : 'else';
    } else if (ts.isWhileStatement(current) || ts.isDoStatement(current)) {
      expression = current.expression;
      branch = containsNode(current.expression, call) ? 'condition' : 'body';
    } else if (ts.isForStatement(current) && current.condition !== undefined) {
      expression = current.condition;
      branch = containsNode(current.condition, call) ? 'condition' : 'body';
    } else if (ts.isForInStatement(current) || ts.isForOfStatement(current)) {
      expression = current.expression;
      branch = containsNode(current.expression, call) ? 'expression' : 'body';
    } else if (ts.isSwitchStatement(current)) {
      expression = current.expression;
      branch = containsNode(current.expression, call) ? 'expression' : 'clause';
    } else if (ts.isCaseClause(current)) {
      expression = current.expression;
      branch = 'case';
    } else if (ts.isConditionalExpression(current)) {
      expression = current.condition;
      branch = containsNode(current.whenTrue, call)
        ? 'true'
        : containsNode(current.whenFalse, call)
          ? 'false'
          : 'condition';
    } else if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
      containsNode(current.right, call)
    ) {
      expression = current.left;
      branch = 'right:' + current.operatorToken.getText(sourceFile);
    }
    if (expression !== undefined) {
      descriptors.push(current.kind + ':' + branch + ':' + expression.getText(sourceFile));
      roots.push(...referencedIdentifiers(expression));
    }
  }
  return { descriptors: descriptors.reverse(), roots };
}

function warningStatementText(
  sourceFile: ts.SourceFile,
  call: ts.CallExpression | ts.NewExpression,
  scope: ExecutableFunction,
): string {
  for (
    let current: ts.Node | undefined = call;
    current && current !== scope;
    current = current.parent
  ) {
    if (
      ts.isVariableStatement(current) ||
      ts.isExpressionStatement(current) ||
      ts.isReturnStatement(current) ||
      ts.isThrowStatement(current)
    ) {
      return current.getText(sourceFile);
    }
  }
  return call.getText(sourceFile);
}

function sourceOccurrenceFingerprint(
  content: string,
  index: number,
  evidence: string,
): string | undefined {
  const sourceFile = ts.createSourceFile(
    'precommit-scanner-source.ts',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const located = nodeAtPosition(sourceFile, index);
  const call = located === undefined ? undefined : enclosingCall(located);
  if (call === undefined) {
    const topLevelStatement =
      located === undefined ? undefined : enclosingTopLevelStatement(located);
    if (topLevelStatement === undefined) return undefined;
    return createHash('sha256')
      .update(
        JSON.stringify({ scope: 'top-level', statement: topLevelStatement.getText(sourceFile) }),
      )
      .digest('hex');
  }

  const functionScope = enclosingFunction(call);
  const topLevelStatement = enclosingTopLevelStatement(call);
  if (functionScope === undefined) {
    if (topLevelStatement === undefined) return undefined;
    return createHash('sha256')
      .update(
        JSON.stringify({ scope: 'top-level', statement: topLevelStatement.getText(sourceFile) }),
      )
      .digest('hex');
  }

  const scopeIdentity = lexicalScopeIdentity(sourceFile, functionScope);
  if (scopeIdentity === undefined) return undefined;
  const controls = controlFlowDependencies(sourceFile, call, functionScope);
  const argumentReferences = call.arguments?.flatMap(referencedIdentifiers) ?? [];
  const dependencies = collectDependencyClosure(
    sourceFile,
    [...argumentReferences, ...controls.roots],
    call.getStart(sourceFile),
  );

  return createHash('sha256')
    .update(
      JSON.stringify({
        scopeIdentity,
        warningStatement: warningStatementText(sourceFile, call, functionScope),
        controls: controls.descriptors,
        dependencies: dependencies ?? ['unresolved'],
      }),
    )
    .digest('hex');
}

export function readGitBlob(
  repoRoot: string,
  revision: string,
  relativePath: string,
): string | undefined {
  try {
    return execFileSync('git', ['show', revision + ':' + relativePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

export function readIndexedContent(repoRoot: string, relativePath: string): string {
  const staged = readGitBlob(repoRoot, '', relativePath);
  if (staged === undefined) {
    throw new Error('D3_INDEX_BLOB_UNAVAILABLE:' + relativePath);
  }
  return staged;
}

export async function enumerateHighWarnings(
  content: string,
  scan: (content: string) => Promise<readonly ScannerWarning[]> | readonly ScannerWarning[],
): Promise<ScannerWarning[]> {
  const warnings: ScannerWarning[] = [];
  let remaining = content;

  for (let iteration = 0; iteration < MAX_HIGH_WARNING_OCCURRENCES; iteration += 1) {
    const highWarnings = (await scan(remaining)).filter(
      (warning) => isHighWarning(warning) && !isMalwareOrCritical(warning),
    );
    if (highWarnings.length === 0) return warnings;

    for (const warning of highWarnings) {
      const evidence = warningEvidencePrefix(warning.evidence);
      const index = remaining.indexOf(evidence);
      if (index < 0 || evidence.length === 0) {
        throw new Error('D3_SCANNER_WARNING_EVIDENCE_UNRESOLVABLE');
      }
      const sourceFingerprint = sourceOccurrenceFingerprint(content, index, evidence);
      warnings.push({ ...warning, ...(sourceFingerprint ? { sourceFingerprint } : {}) });
      remaining =
        remaining.slice(0, index) +
        ' '.repeat(evidence.length) +
        remaining.slice(index + evidence.length);
    }
  }

  throw new Error('D3_SCANNER_WARNING_OCCURRENCE_LIMIT');
}

export function evaluateIndexedWarnings(
  stagedWarnings: readonly ScannerWarning[],
  headWarnings: readonly ScannerWarning[],
): {
  inherited: ScannerPolicyAuditWarning[];
  violations: ScannerPolicyViolation[];
} {
  const inherited: ScannerPolicyAuditWarning[] = [];
  const violations: ScannerPolicyViolation[] = [];
  const baselineOccurrences = new Map<string, string[]>();
  const consumedBaselineOccurrences = new Map<string, Set<number>>();
  const unmatchedStagedWarnings: ScannerPolicyAuditWarning[] = [];

  for (const warning of headWarnings) {
    if (!isHighWarning(warning) || isMalwareOrCritical(warning)) continue;
    if (warning.sourceFingerprint === undefined) continue;
    const fingerprint = warningFingerprint(warning);
    const occurrences = baselineOccurrences.get(fingerprint) ?? [];
    occurrences.push(warning.sourceFingerprint);
    baselineOccurrences.set(fingerprint, occurrences);
  }

  for (const warning of stagedWarnings) {
    const audit = auditWarning(warning);
    if (isMalwareOrCritical(warning)) {
      violations.push({ ...audit, reason: 'malware_or_critical' });
      continue;
    }
    if (!isHighWarning(warning)) continue;

    if (warning.sourceFingerprint === undefined) {
      violations.push({ ...audit, reason: 'new_high_warning' });
      continue;
    }

    const baseline = baselineOccurrences.get(audit.fingerprint) ?? [];
    const consumed = consumedBaselineOccurrences.get(audit.fingerprint) ?? new Set<number>();
    const match = baseline.findIndex(
      (sourceFingerprint, index) =>
        !consumed.has(index) && sourceFingerprint === warning.sourceFingerprint,
    );
    if (match >= 0) {
      consumed.add(match);
      consumedBaselineOccurrences.set(audit.fingerprint, consumed);
      inherited.push(audit);
    } else {
      unmatchedStagedWarnings.push(audit);
    }
  }

  for (const audit of unmatchedStagedWarnings) {
    violations.push({
      ...audit,
      reason: baselineOccurrences.has(audit.fingerprint)
        ? 'duplicate_high_warning'
        : 'new_high_warning',
    });
  }

  return { inherited, violations };
}
