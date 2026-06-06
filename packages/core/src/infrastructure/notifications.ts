/**
 * Notification Infrastructure
 *
 * Sends notifications via multiple channels when events occur.
 * Channels: terminal bell, desktop notification, Slack, Discord, webhook.
 *
 * Usage:
 *   commander notify "build done"              # Desktop notification
 *   commander notify "deploy done" --slack     # Slack notification
 *   commander config set notify.slack.webhook <url>
 */

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export type NotificationChannel = 'desktop' | 'terminal' | 'slack' | 'discord' | 'webhook';

export interface NotificationConfig {
  desktop: { enabled: boolean };
  terminal: { enabled: boolean };
  slack: { enabled: boolean; webhookUrl: string; channel?: string };
  discord: { enabled: boolean; webhookUrl: string };
  webhook: { enabled: boolean; url: string; headers?: Record<string, string> };
}

export interface NotificationMessage {
  title: string;
  body: string;
  channel?: NotificationChannel;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Notification Manager
// ============================================================================

export class NotificationManager {
  private config: NotificationConfig;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? path.join(process.cwd(), '.commander', 'notifications.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): NotificationConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    return {
      desktop: { enabled: true },
      terminal: { enabled: true },
      slack: { enabled: false, webhookUrl: '' },
      discord: { enabled: false, webhookUrl: '' },
      webhook: { enabled: false, url: '' },
    };
  }

  private saveConfig(): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * Update notification config.
   */
  configure(channel: NotificationChannel, settings: Record<string, unknown>): void {
    const current = this.config[channel] as Record<string, unknown>;
    const merged = { ...current, ...settings };
    this.config = { ...this.config, [channel]: merged };
    this.saveConfig();
  }

  /**
   * Send a notification.
   */
  async send(message: NotificationMessage): Promise<void> {
    const channel = message.channel ?? this.getDefaultChannel();
    const promises: Promise<void>[] = [];

    switch (channel) {
      case 'desktop':
        promises.push(this.sendDesktop(message));
        break;
      case 'terminal':
        promises.push(this.sendTerminal(message));
        break;
      case 'slack':
        promises.push(this.sendSlack(message));
        break;
      case 'discord':
        promises.push(this.sendDiscord(message));
        break;
      case 'webhook':
        promises.push(this.sendWebhook(message));
        break;
      case undefined:
        // Send to all enabled channels
        if (this.config.desktop.enabled) promises.push(this.sendDesktop(message));
        if (this.config.terminal.enabled) promises.push(this.sendTerminal(message));
        if (this.config.slack.enabled) promises.push(this.sendSlack(message));
        if (this.config.discord.enabled) promises.push(this.sendDiscord(message));
        if (this.config.webhook.enabled) promises.push(this.sendWebhook(message));
        break;
    }

    await Promise.allSettled(promises);
  }

  private getDefaultChannel(): NotificationChannel {
    if (this.config.slack.enabled) return 'slack';
    if (this.config.discord.enabled) return 'discord';
    if (this.config.desktop.enabled) return 'desktop';
    return 'terminal';
  }

  /**
   * Desktop notification (macOS/Linux).
   */
  private async sendDesktop(message: NotificationMessage): Promise<void> {
    try {
      const { execFile } = await import('child_process');
      const title = message.title.slice(0, 100);
      const body = message.body.slice(0, 500);

      // Use execFile to avoid shell injection
      if (process.platform === 'darwin') {
        execFile('osascript', ['-e', `display notification "${body.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with title "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`]);
      } else if (process.platform === 'linux') {
        execFile('notify-send', [title, body]);
      }
    } catch { /* best-effort */ }
  }

  /**
   * Terminal bell + visual notification.
   */
  private async sendTerminal(message: NotificationMessage): Promise<void> {
    // Terminal bell
    process.stdout.write('\x07');

    // Visual notification
    const icon = message.priority === 'urgent' ? '🔴' : message.priority === 'high' ? '🟡' : '🔔';
    console.log(`\n${icon} ${message.title}: ${message.body}\n`);
  }

  /**
   * Slack webhook notification.
   */
  private async sendSlack(message: NotificationMessage): Promise<void> {
    if (!this.config.slack.enabled || !this.config.slack.webhookUrl) return;

    try {
      const payload: Record<string, unknown> = {
        text: `*${message.title}*\n${message.body}`,
      };
      if (this.config.slack.channel) {
        payload.channel = this.config.slack.channel;
      }

      await fetch(this.config.slack.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      getGlobalLogger().warn('NotificationManager', 'Slack notification failed', { error: String(err) });
    }
  }

  /**
   * Discord webhook notification.
   */
  private async sendDiscord(message: NotificationMessage): Promise<void> {
    if (!this.config.discord.enabled || !this.config.discord.webhookUrl) return;

    try {
      await fetch(this.config.discord.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: message.title,
            description: message.body,
            color: message.priority === 'urgent' ? 0xff0000 : message.priority === 'high' ? 0xffaa00 : 0x00ff00,
          }],
        }),
      });
    } catch (err) {
      getGlobalLogger().warn('NotificationManager', 'Discord notification failed', { error: String(err) });
    }
  }

  /**
   * Generic webhook notification.
   */
  private async sendWebhook(message: NotificationMessage): Promise<void> {
    if (!this.config.webhook.enabled || !this.config.webhook.url) return;

    try {
      await fetch(this.config.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.webhook.headers,
        },
        body: JSON.stringify({
          title: message.title,
          body: message.body,
          priority: message.priority,
          timestamp: new Date().toISOString(),
          ...message.metadata,
        }),
      });
    } catch (err) {
      getGlobalLogger().warn('NotificationManager', 'Webhook notification failed', { error: String(err) });
    }
  }

  /**
   * Get current config (for display).
   */
  getConfig(): NotificationConfig {
    return { ...this.config };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultManager: NotificationManager | null = null;

export function getNotificationManager(): NotificationManager {
  if (!defaultManager) {
    defaultManager = new NotificationManager();
  }
  return defaultManager;
}
