/**
 * Endpoint Registry — centralizes router mounting into a declarative manifest.
 *
 * Previously adding an endpoint required three manual steps across index.ts:
 *   ① create the router factory file
 *   ② add an `import` statement at the top of index.ts
 *   ③ add an `app.use(path, factory(...))` line further down
 *
 * The mount list was scattered across ~60 lines interleaved with comments,
 * making it hard to see the full surface area and easy to forget a step. This
 * registry collapses steps ② + ③ into a single declarative `registerRouter()`
 * call. New endpoints still need their factory file, but wiring is now ONE line
 * in a manifest rather than an import + a mount statement in two places.
 *
 * Ordering is preserved (registration order = mount order), which matters
 * because auth/audit/DLP middleware must run before routers, and some routers
 * rely on shared state initialized earlier in index.ts.
 */

import type { Express, RequestHandler } from 'express';

/**
 * OpenAPI metadata applied to all routes in a registration (WS3 §4.1).
 * The generator applies these as defaults to every route extracted from the
 * registration's factory router. Non-/v1 routes are automatically marked
 * `deprecated: true` + `x-legacy: true` by the generator, so registrations
 * only need to set these when overriding the default behaviour.
 */
export interface OpenApiMeta {
  /** Tags for grouping in the OpenAPI document (e.g. ['Runs']). */
  tags?: string[];
  /** Short summary for the route. Applied as a prefix or fallback. */
  summary?: string;
  /** Longer description. */
  description?: string;
  /** Mark all routes in this registration as deprecated. */
  deprecated?: boolean;
  /** Mark with the x-legacy extension. */
  xLegacy?: boolean;
  /** Parameters (path/query/header) for all routes. */
  parameters?: unknown[];
  /** Request body schema. */
  requestBody?: unknown;
  /** Response code → description map. */
  responses?: Record<string, { description: string }>;
}

export interface RouterRegistration {
  /** Stable identifier for logging / OpenAPI generation. */
  name: string;
  /** Mount path. Use '/' for root mount (Express treats '/' and '' equivalently). */
  mountPath: string;
  /** Factory returning an Express Router / RequestHandler. Captures shared deps
   *  via closure from the registration site (see index.ts manifest section). */
  factory: () => RequestHandler;
  /**
   * Optional OpenAPI metadata applied to all routes in this registration
   * (WS3 §4.1). The generator uses this as default metadata when producing
   * /v1/openapi.json from the actual router stack.
   */
  openapi?: OpenApiMeta;
}

const registrations: RouterRegistration[] = [];

/**
 * Register a router to be mounted. Call this in the manifest section of
 * index.ts (or from a router module's side-effect import for full
 * self-registration). Registration order = mount order.
 */
export function registerRouter(reg: RouterRegistration): void {
  if (!reg.mountPath) reg.mountPath = '/';
  registrations.push(reg);
}

/** All registered routers in mount order. Returns a defensive copy so callers
 *  cannot mutate the registry's internal array. */
export function listRegisteredRouters(): readonly RouterRegistration[] {
  return registrations.slice();
}

/**
 * Mount every registered router onto the Express app in registration order.
 * Called once from index.ts after the manifest is fully populated.
 */
export function mountRegisteredRouters(app: Express): void {
  for (const reg of registrations) {
    app.use(reg.mountPath, reg.factory());
  }
}

/** Reset the registry (test isolation helper). */
export function resetRouterRegistry(): void {
  registrations.length = 0;
}
