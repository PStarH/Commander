import { getGlobalLogger } from '../logging';
import { getIMProviderRegistry } from './imProviderRegistry';
import type { IMReply, IMOutboundCredentials } from './imProvider';

export interface IMWebhookConfig {
  id: string;
  platform: string;
  name: string;
  secret: string;
  agentId: string;
  enabled: boolean;
  createdAt: string;
  outbound?: IMOutboundCredentials;
}

export interface IMWebhookConfigSource {
  findById(id: string): IMWebhookConfig | undefined;
}

export interface IMOutboundDispatcher {
  send(configId: string, reply: IMReply): Promise<void>;
}

export class DefaultIMOutboundDispatcher implements IMOutboundDispatcher {
  constructor(private source: IMWebhookConfigSource) {}

  async send(configId: string, reply: IMReply): Promise<void> {
    const cfg = this.source.findById(configId);
    if (!cfg || !cfg.enabled) {
      getGlobalLogger().warn('IMOutboundDispatcher', 'Skipping send: config missing or disabled', {
        configId,
      });
      return;
    }
    const provider = getIMProviderRegistry().resolve(cfg.platform);
    if (!provider?.sendMessage) {
      getGlobalLogger().warn('IMOutboundDispatcher', 'Skipping send: provider lacks sendMessage', {
        configId,
        platform: cfg.platform,
      });
      return;
    }
    try {
      await provider.sendMessage(reply.conversationId ?? cfg.id, reply, cfg.outbound ?? {});
    } catch (err) {
      getGlobalLogger().error('IMOutboundDispatcher', 'Failed to send IM message', err as Error, {
        configId,
        platform: cfg.platform,
      });
    }
  }
}

let dispatcher: IMOutboundDispatcher | undefined;

export function getIMOutboundDispatcher(source?: IMWebhookConfigSource): IMOutboundDispatcher {
  if (!dispatcher) {
    if (!source) {
      throw new Error('IMOutboundDispatcher requires a config source on first use');
    }
    dispatcher = new DefaultIMOutboundDispatcher(source);
  }
  return dispatcher;
}

export function resetIMOutboundDispatcher(source?: IMWebhookConfigSource): IMOutboundDispatcher {
  if (!source) {
    throw new Error('resetIMOutboundDispatcher requires a config source');
  }
  dispatcher = new DefaultIMOutboundDispatcher(source);
  return dispatcher;
}
