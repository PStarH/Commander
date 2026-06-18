/**
 * Infrastructure — Core systems that Commander needs but agents can't provide.
 *
 * These are not CLI commands. They're background systems that make the agent smarter:
 * - Background tasks: run without blocking terminal
 * - Notifications: Slack/Discord/desktop alerts
 * - Scheduler: cron-like task automation
 * - Webhooks: listen for external events
 */

export { BackgroundTaskManager, getBackgroundTaskManager } from './background';
export type { BackgroundJob, BackgroundJobOptions } from './background';

export { NotificationManager, getNotificationManager } from './notifications';
export type { NotificationChannel, NotificationConfig, NotificationMessage } from './notifications';

export { TaskScheduler, getTaskScheduler } from './scheduler';
export type { ScheduledTask, ScheduleOptions } from './scheduler';

export { WebhookManager, getWebhookManager } from './webhooks';
export type { WebhookRule, WebhookEvent } from './webhooks';
