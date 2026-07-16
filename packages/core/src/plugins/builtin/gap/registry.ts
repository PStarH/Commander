// packages/core/src/plugins/builtin/gap/registry.ts
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { readNdjson, appendNdjson } from './storage';
import {
  GapEntry,
  GapSource,
  GapSeverity,
  GapStatus,
  computeSlaDeadline,
  isOverdue,
} from './types';
import {
  IntegrityLayer,
  UniversalSanitizer,
  SignedEntry,
} from '../../../security/securityPrimitives';

export interface RecordGapInput {
  source: GapSource;
  severity: GapSeverity;
  title: string;
  description: string;
  detectedAt?: string;
  status?: GapStatus;
  owner?: string;
  relatedIssues?: string[];
  slaDeadline?: string;
}

export interface ListFilter {
  source?: GapSource;
  severity?: GapSeverity;
  status?: GapStatus;
}

export class GapRegistry {
  private readonly integrity: IntegrityLayer;
  private readonly sanitizer: UniversalSanitizer;

  constructor(private registryFile: string) {
    this.integrity = new IntegrityLayer();
    this.sanitizer = new UniversalSanitizer();
  }

  record(input: RecordGapInput): GapEntry {
    const detectedAt = input.detectedAt ?? new Date().toISOString();
    const slaDeadline =
      input.slaDeadline ?? computeSlaDeadline(input.severity, new Date(detectedAt));
    const title = this.sanitizer.sanitize(input.title, 'identifier').sanitized;
    const description = this.sanitizer.sanitize(input.description, 'description').sanitized;
    const entry: GapEntry = {
      id: this.generateId(detectedAt),
      source: input.source,
      severity: input.severity,
      title,
      description,
      detectedAt,
      status: input.status ?? 'open',
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      relatedIssues: input.relatedIssues ?? [],
      slaDeadline,
    };
    const signed = this.integrity.sign(entry as unknown as Record<string, unknown>);
    appendNdjson(this.registryFile, [signed]);
    return entry;
  }

  get(id: string): GapEntry | undefined {
    return this.list().find((e) => e.id === id);
  }

  list(filter?: ListFilter): GapEntry[] {
    const signed = readNdjson<SignedEntry>(this.registryFile);
    const all: GapEntry[] = [];
    for (const s of signed) {
      // Reject entries that fail HMAC verification (tampered or unsigned).
      if (!this.integrity.verify(s)) continue;
      const { _ts: _dataTs, ...entryData } = s.data;
      all.push(entryData as unknown as GapEntry);
    }
    if (!filter) return all;
    return all.filter((e) => {
      if (filter.source && e.source !== filter.source) return false;
      if (filter.severity && e.severity !== filter.severity) return false;
      if (filter.status && e.status !== filter.status) return false;
      return true;
    });
  }

  close(id: string, notes: string, regressionTestIds: string[]): void {
    if (!regressionTestIds || regressionTestIds.length === 0) {
      throw new Error('regressionTestIds must not be empty');
    }
    const signed = readNdjson<SignedEntry>(this.registryFile);
    const idx = signed.findIndex((s) => {
      if (!this.integrity.verify(s)) return false;
      return (s.data as Record<string, unknown>).id === id;
    });
    if (idx < 0) throw new Error(`Gap ${id} not found`);
    const { _ts: _dataTs, ...entryData } = signed[idx].data;
    const entry = entryData as unknown as GapEntry;
    const updated: GapEntry = {
      ...entry,
      status: 'fixed',
      closedAt: new Date().toISOString(),
      resolutionNotes: notes,
      regressionCheck: {
        lastVerified: new Date().toISOString(),
        testIds: regressionTestIds,
      },
    };
    signed[idx] = this.integrity.sign(updated as unknown as Record<string, unknown>);
    fs.writeFileSync(
      this.registryFile,
      signed.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );
  }

  detectOverdueSla(now: Date = new Date()): GapEntry[] {
    return this.list({ status: 'open' }).filter((e) => isOverdue(e.slaDeadline, now));
  }

  private generateId(detectedAt: string): string {
    const date = new Date(detectedAt).toISOString().slice(0, 10);
    const sameDay = this.list().filter((e) => e.id.startsWith(`gap-${date}`)).length;
    const suffix = crypto.randomBytes(2).toString('hex');
    return `gap-${date}-${String(sameDay + 1).padStart(3, '0')}-${suffix}`;
  }
}
