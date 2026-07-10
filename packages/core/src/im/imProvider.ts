export interface IMIncomingRequest {
  /** HTTP method (uppercase). */
  method: string;
  /** Parsed URL query parameters. */
  query: Record<string, string | string[] | undefined>;
  /** Parsed request body. */
  body: unknown;
  /** Normalized request headers. */
  headers: Record<string, string | string[] | undefined>;
}

export interface IMMessage {
  /** Raw platform-specific message identifier. */
  messageId?: string;
  /** Sender identifier within the IM platform. */
  senderId: string;
  /** Conversation / group / thread identifier. */
  conversationId: string;
  /** Plain text content after platform parsing but before @-mention stripping. */
  text: string;
  /** IDs that were @mentioned in the message. */
  mentionIds?: string[];
  /** Platform-specific extra payload (e.g., Feishu message type). */
  metadata?: Record<string, unknown>;
}

export interface IMReply {
  /** Response text to send back to the IM platform. */
  text: string;
  /** Optional thread/conversation ID to reply in (if different from incoming). */
  conversationId?: string;
  /** Optional extra metadata for rich replies. */
  metadata?: Record<string, unknown>;
}

export interface IMProvider {
  /** Unique provider ID, matches the `platform` field in IMWebhookConfig. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Verify that the incoming webhook request genuinely came from the IM platform. */
  verify(req: IMIncomingRequest, secret: string): boolean | Promise<boolean>;
  /** Parse the platform request into a normalized IMMessage. */
  parseMessage(req: IMIncomingRequest): IMMessage | Promise<IMMessage>;
  /** Format the Agent reply into a platform-specific response body/headers. */
  formatReply(reply: IMReply): { body: unknown; headers?: Record<string, string>; status?: number };
  /** Strip platform-specific @bot mention text from message text. */
  stripMention(text: string): string;
  /**
   * Optional: Send a proactive message via platform API.
   * When absent, the host falls back to HTTP response formatReply.
   */
  sendMessage?(conversationId: string, reply: IMReply, config: unknown): Promise<void>;
}
