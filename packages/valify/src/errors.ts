export interface ValifyIssue {
  path: (string | number)[];
  message: string;
  code: string;
}

export class ValifyError extends Error {
  public readonly issues: ValifyIssue[];

  constructor(issues: ValifyIssue[]) {
    const msg = issues
      .map((i) => {
        const p = i.path.length > 0 ? ` at "${i.path.join('.')}"` : '';
        return `${i.message}${p}`;
      })
      .join('; ');
    super(msg);
    this.name = 'ValifyError';
    this.issues = issues;
  }

  get formatted(): string {
    return this.issues
      .map((i) => {
        const p = i.path.length > 0 ? i.path.join('.') : '(root)';
        return `[${p}] ${i.message}`;
      })
      .join('\n');
  }
}

export function createIssue(path: (string | number)[], message: string, code: string): ValifyIssue {
  return { path, message, code };
}

export function prependPath(issues: ValifyIssue[], key: string | number): ValifyIssue[] {
  return issues.map((issue) => ({ ...issue, path: [key, ...issue.path] }));
}
