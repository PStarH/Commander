// ============================================================================
// Hub Glue: barrel export
// ============================================================================
export {
  HUB_TOPICS,
  WRITE_TOPICS,
  getSinksForTopic,
  EventGlue,
  install,
  getEventGlue,
  resetForTests,
} from './eventGlue';

export type {
  HubTopic,
  BackendName,
  GlueMode,
  EventGlueOptions,
} from './eventGlue';
