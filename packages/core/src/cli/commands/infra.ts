/**
 * Infrastructure CLI Commands
 *
 * Commands for managing background tasks, notifications, scheduler, and webhooks.
 */

import { $ } from '../util';
import { getBackgroundTaskManager } from '../../infrastructure/background';
import { getNotificationManager } from '../../infrastructure/notifications';
import { getTaskScheduler } from '../../infrastructure/scheduler';
import { getWebhookManager } from '../../infrastructure/webhooks';

// ============================================================================
// commander jobs — Background task management
// ============================================================================

export async function cmdJobs(args: string[]): Promise<void> {
  const manager = getBackgroundTaskManager();

  if (args.length === 0) {
    // List all jobs
    const jobs = manager.listJobs();
    console.log(`\n  ${$.cyan}${$.bold}Background Jobs${$.reset}\n`);

    if (jobs.length === 0) {
      console.log(
        `  ${$.dim}No jobs found. Use ${$.bold}commander run "task" --background${$.reset}${$.dim} to start one.${$.reset}\n`,
      );
      return;
    }

    for (const job of jobs.slice(0, 20)) {
      const statusIcon =
        job.status === 'running'
          ? '🔄'
          : job.status === 'completed'
            ? '✅'
            : job.status === 'failed'
              ? '❌'
              : '⏹️';
      const duration = job.completedAt
        ? `${Math.round((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)}s`
        : 'running';
      console.log(
        `  ${statusIcon} ${$.bold}${job.id}${$.reset} ${$.dim}${job.task.slice(0, 50)}${$.reset} [${duration}]`,
      );
    }
    console.log(`\n  ${$.dim}Total: ${jobs.length} jobs${$.reset}\n`);
    return;
  }

  const jobId = args[0];
  const job = manager.getJob(jobId);

  if (!job) {
    console.log(`  ${$.red}Job not found:${$.reset} ${jobId}\n`);
    return;
  }

  // Show job details
  console.log(`\n  ${$.cyan}${$.bold}Job Details${$.reset}\n`);
  console.log(`  ${$.bold}ID:${$.reset} ${job.id}`);
  console.log(`  ${$.bold}Task:${$.reset} ${job.task}`);
  console.log(`  ${$.bold}Status:${$.reset} ${job.status}`);
  console.log(`  ${$.bold}Started:${$.reset} ${job.startedAt}`);
  if (job.completedAt) console.log(`  ${$.bold}Completed:${$.reset} ${job.completedAt}`);
  if (job.pid) console.log(`  ${$.bold}PID:${$.reset} ${job.pid}`);
  if (job.exitCode !== undefined) console.log(`  ${$.bold}Exit Code:${$.reset} ${job.exitCode}`);
  if (job.error) console.log(`  ${$.bold}Error:${$.reset} ${$.red}${job.error}${$.reset}`);

  // Show logs if requested
  if (args.includes('--logs') || args.includes('-l')) {
    const logs = manager.getLogs(jobId, 50);
    if (logs.length > 0) {
      console.log(`\n  ${$.bold}Logs (last 50 lines):${$.reset}`);
      for (const line of logs) {
        console.log(`    ${$.dim}${line}${$.reset}`);
      }
    }
  }

  // Stop if requested
  if (args.includes('--stop') || args.includes('-s')) {
    if (manager.stopJob(jobId)) {
      console.log(`\n  ${$.green}✓${$.reset} Job stopped`);
    } else {
      console.log(`\n  ${$.yellow}⚠${$.reset} Job is not running or already finished`);
    }
  }

  console.log('');
}

// ============================================================================
// commander notify — Send notification
// ============================================================================

export async function cmdNotify(message: string, flags: Record<string, string>): Promise<void> {
  const manager = getNotificationManager();

  // parseFlags() strips the leading "--" from flag keys, so keys are bare
  // names (e.g. "slack", "priority"). Booleans are encoded as "true".
  const channel = flags['slack']
    ? 'slack'
    : flags['discord']
      ? 'discord'
      : flags['webhook']
        ? 'webhook'
        : undefined;

  await manager.send({
    title: 'Commander',
    body: message,
    channel: channel as 'desktop' | 'terminal' | 'slack' | 'discord' | 'webhook' | undefined,
    priority: (flags['priority'] as 'low' | 'normal' | 'high' | 'urgent' | undefined) ?? 'normal',
  });

  console.log(`  ${$.green}✓${$.reset} Notification sent`);
}

// ============================================================================
// commander schedule — Task scheduler
// ============================================================================

export async function cmdSchedule(args: string[]): Promise<void> {
  const scheduler = getTaskScheduler();

  if (args.length === 0 || args[0] === 'list') {
    const tasks = scheduler.list();
    console.log(`\n  ${$.cyan}${$.bold}Scheduled Tasks${$.reset}\n`);

    if (tasks.length === 0) {
      console.log(`  ${$.dim}No scheduled tasks.${$.reset}`);
      console.log(
        `  ${$.dim}Add one: ${$.bold}commander schedule add "task name" --cron "0 2 * * *"${$.reset}\n`,
      );
      return;
    }

    for (const task of tasks) {
      const statusIcon = task.enabled ? '🟢' : '⚫';
      const schedule =
        task.cron ?? `every ${task.intervalMs ? Math.round(task.intervalMs / 60000) + 'm' : '?'}`;
      const lastRun = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : 'never';
      console.log(`  ${statusIcon} ${$.bold}${task.name}${$.reset} [${schedule}] last: ${lastRun}`);
    }
    console.log(`\n  ${$.dim}Total: ${tasks.length} tasks${$.reset}\n`);
    return;
  }

  const subcommand = args[0];

  if (subcommand === 'add') {
    const name = args[1];
    const task = args[2] ?? name;
    const cron = args.includes('--cron') ? args[args.indexOf('--cron') + 1] : undefined;
    const every = args.includes('--every') ? args[args.indexOf('--every') + 1] : undefined;

    if (!name) {
      console.log(`  ${$.red}Usage:${$.reset} commander schedule add "name" --cron "0 2 * * *"`);
      return;
    }

    const scheduled = scheduler.add({ name, task, cron, every });
    console.log(`  ${$.green}✓${$.reset} Scheduled: ${scheduled.name} (${scheduled.id})`);
    if (scheduled.nextRunAt) {
      console.log(
        `  ${$.dim}Next run: ${new Date(scheduled.nextRunAt).toLocaleString()}${$.reset}`,
      );
    }
    return;
  }

  if (subcommand === 'remove') {
    const id = args[1];
    if (scheduler.remove(id)) {
      console.log(`  ${$.green}✓${$.reset} Removed`);
    } else {
      console.log(`  ${$.red}Not found:${$.reset} ${id}`);
    }
    return;
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const id = args[1];
    const enabled = subcommand === 'enable';
    if (scheduler.toggle(id, enabled)) {
      console.log(`  ${$.green}✓${$.reset} ${enabled ? 'Enabled' : 'Disabled'}`);
    } else {
      console.log(`  ${$.red}Not found:${$.reset} ${id}`);
    }
    return;
  }

  console.log(`  ${$.red}Unknown subcommand:${$.reset} ${subcommand}`);
}

// ============================================================================
// commander webhook — Webhook management
// ============================================================================

export async function cmdWebhook(args: string[]): Promise<void> {
  const manager = getWebhookManager();

  if (args.length === 0 || args[0] === 'list') {
    const rules = manager.list();
    console.log(`\n  ${$.cyan}${$.bold}Webhook Rules${$.reset}\n`);

    if (rules.length === 0) {
      console.log(`  ${$.dim}No webhook rules.${$.reset}`);
      console.log(
        `  ${$.dim}Add one: ${$.bold}commander webhook add github --events push,pr --task "run tests"${$.reset}\n`,
      );
      return;
    }

    for (const rule of rules) {
      const statusIcon = rule.enabled ? '🟢' : '⚫';
      console.log(
        `  ${statusIcon} ${$.bold}${rule.name}${$.reset} [${rule.source}:${rule.events.join(',')}] triggered: ${rule.triggerCount}x`,
      );
    }
    console.log(`\n  ${$.dim}Total: ${rules.length} rules${$.reset}\n`);
    return;
  }

  const subcommand = args[0];

  if (subcommand === 'add') {
    const source = args[1] as 'github' | 'gitlab' | 'bitbucket' | 'custom' | undefined;
    const eventsIdx = args.indexOf('--events');
    const taskIdx = args.indexOf('--task');
    const events = eventsIdx >= 0 ? args[eventsIdx + 1].split(',') : ['*'];
    const task = taskIdx >= 0 ? args[taskIdx + 1] : args[2];

    if (!source || !task) {
      console.log(
        `  ${$.red}Usage:${$.reset} commander webhook add github --events push,pr --task "run tests"`,
      );
      return;
    }

    const rule = manager.add({
      name: `${source}-${events.join('-')}`,
      source,
      events,
      task,
      enabled: true,
    });
    console.log(`  ${$.green}✓${$.reset} Added: ${rule.name} (${rule.id})`);
    return;
  }

  if (subcommand === 'remove') {
    const id = args[1];
    if (manager.remove(id)) {
      console.log(`  ${$.green}✓${$.reset} Removed`);
    } else {
      console.log(`  ${$.red}Not found:${$.reset} ${id}`);
    }
    return;
  }

  if (subcommand === 'start') {
    const port = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1]) : 9876;
    await manager.startServer(port);
    console.log(`  ${$.green}✓${$.reset} Webhook server started on port ${port}`);
    console.log(`  ${$.dim}Press Ctrl+C to stop${$.reset}`);
    // Keep alive
    await new Promise(() => {});
    return;
  }

  console.log(`  ${$.red}Unknown subcommand:${$.reset} ${subcommand}`);
}
