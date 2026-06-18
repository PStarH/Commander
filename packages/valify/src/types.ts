import type { ValifyIssue } from './errors.js';

export type ParseResult<T> = { success: true; data: T } | { success: false; error: ValifyIssue[] };

export interface ValifySchemaDef<T> {
  _type: string;
  _output: T;
  _optional: boolean;
  _nullable: boolean;
  _default?: T;
  _hasDefault: boolean;
  _refines: Array<{ fn: (val: T) => boolean | Promise<boolean>; message: string }>;
  _coerce: boolean;
}

export type ValifySchema<T> = {
  _def: ValifySchemaDef<T>;
  parse: (input: unknown) => T;
  safeParse: (input: unknown) => ParseResult<T>;
  parseAsync: (input: unknown) => Promise<T>;
  safeParseAsync: (input: unknown) => Promise<ParseResult<T>>;
};

export type Infer<T extends ValifySchema<any>> = T extends ValifySchema<infer U> ? U : never;
