import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DeprecatedAuthority {
  id: string;
  routes: string[];
  replacement: string;
  sunsetAt: string;
  status: string;
}

function repoRoot(): string {
  const candidates = [process.cwd(), resolve(process.cwd(), '../..'), resolve(process.cwd(), '..')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'config/deprecated-authorities.json'))) return candidate;
  }
  return process.cwd();
}

function loadInventory(): DeprecatedAuthority[] {
  const path = join(repoRoot(), 'config/deprecated-authorities.json');
  // Image builds must COPY this file; missing inventory must not 500 product routes.
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      authorities?: DeprecatedAuthority[];
    };
    return (parsed.authorities ?? []).filter((a) => a.status === 'deprecated');
  } catch {
    return [];
  }
}

let inventory: DeprecatedAuthority[] | undefined;
function getInventory(): DeprecatedAuthority[] {
  inventory ??= loadInventory();
  return inventory;
}

const counters = new Map<string, number>();

export function getDeprecatedPathCount(surface: string): number {
  return counters.get(surface) ?? 0;
}

export function resetDeprecatedPathCounters(): void {
  counters.clear();
}

function routePatternToRegex(route: string): RegExp {
  const [method, pathPattern] = route.split(' ');
  const escaped = pathPattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z]+)/g, '[^/]+');
  return new RegExp(`^${method}\\s+${escaped}$`);
}

function matchInventoryRoute(method: string, path: string): DeprecatedAuthority | undefined {
  const key = `${method.toUpperCase()} ${path}`;
  for (const entry of getInventory()) {
    for (const route of entry.routes) {
      if (routePatternToRegex(route).test(key)) return entry;
      const [, pattern] = route.split(' ');
      if (
        pattern?.endsWith('/*') &&
        key.startsWith(`${method.toUpperCase()} ${pattern.slice(0, -2)}`)
      ) {
        return entry;
      }
    }
  }
  return undefined;
}

function httpDate(isoDate: string): string {
  return new Date(isoDate).toUTCString();
}

export function deprecatedPathMetrics(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const entry = matchInventoryRoute(req.method, req.path);
    if (entry) {
      counters.set(entry.id, (counters.get(entry.id) ?? 0) + 1);
      res.set('Deprecation', 'true');
      res.set('x-legacy', 'true');
      if (entry.sunsetAt) res.set('Sunset', httpDate(entry.sunsetAt));
      if (entry.replacement) {
        const linkTarget = entry.replacement.startsWith('/')
          ? entry.replacement
          : `/${entry.replacement}`;
        res.set('Link', `<${linkTarget}>; rel="successor-version"`);
      }
    }
    next();
  };
}

export function commanderDeprecatedPathRequestsTotal(): string {
  const lines = [
    '# HELP commander_deprecated_path_requests_total Deprecated path requests',
    '# TYPE commander_deprecated_path_requests_total counter',
  ];
  for (const [surface, count] of counters) {
    lines.push(`commander_deprecated_path_requests_total{surface="${surface}"} ${count}`);
  }
  return lines.join('\n') + '\n';
}
