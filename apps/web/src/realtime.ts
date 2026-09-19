/**
 * realtime.ts — the War Room live-refresh contract.
 *
 * apps/api/src/streamEndpoints.ts names every SSE frame after the MessageBus
 * topic that produced it (`event: <topic>`). The War Room hook therefore has to
 * listen for those topic names. It previously listened for a single `snapshot`
 * event, which the server never emits (`snapshot` is not even a valid
 * MessageBusTopic), so live refresh silently depended on the 12s safety poll.
 *
 * WAR_ROOM_REFRESH_TOPICS mirrors the server's DEFAULT_TOPICS. When the server
 * changes its default feed, update this list too — the alignment is asserted by
 * apps/web/test/realtime.test.ts.
 */

/** Bus topics that should trigger a War Room snapshot refresh. */
export const WAR_ROOM_REFRESH_TOPICS = [
  'agent.started',
  'agent.completed',
  'agent.failed',
  'agent.message',
  'mission.updated',
  'mission.blocked',
  'mission.completed',
  'system.alert',
  'tool.executed',
  'tool.started',
  'tool.completed',
] as const;

export type WarRoomRefreshTopic = (typeof WAR_ROOM_REFRESH_TOPICS)[number];

/** True when `topic` is one the War Room refreshes on. */
export function isWarRoomRefreshTopic(topic: string): boolean {
  return (WAR_ROOM_REFRESH_TOPICS as readonly string[]).includes(topic);
}

export interface RefreshBatcherTimers {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface RefreshBatcher {
  /** Queue a refresh; a burst of calls collapses into a single `load` call. */
  schedule(): void;
  /** Drop any queued refresh without running it. */
  cancel(): void;
  /** Whether a refresh is currently queued. */
  readonly pending: boolean;
}

const defaultTimers: RefreshBatcherTimers = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/**
 * Coalesce a burst of realtime events into one refresh. A single agent step can
 * emit several bus topics within a few milliseconds; without batching each one
 * would trigger its own snapshot + memory fetch.
 *
 * `timers` is injectable so the batching behaviour can be tested without a DOM.
 */
export function createRefreshBatcher(
  load: () => void,
  delayMs = 250,
  timers: RefreshBatcherTimers = defaultTimers,
): RefreshBatcher {
  let handle: unknown = null;
  return {
    schedule() {
      if (handle !== null) return;
      handle = timers.setTimeout(() => {
        handle = null;
        load();
      }, delayMs);
    },
    cancel() {
      if (handle === null) return;
      timers.clearTimeout(handle);
      handle = null;
    },
    get pending() {
      return handle !== null;
    },
  };
}
