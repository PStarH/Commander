import type { Tool, ToolDefinition } from '../../runtime/types';

const DEFINITION: ToolDefinition = {
  name: 'vision_analyze',
  description:
    'Analyze an image file (screenshot, diagram, UI mockup, chart). Accepts a file path or base64 data URL. Returns a text description of the image contents.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'File path to image or base64 data URL (data:image/...;base64,...)',
      },
      prompt: {
        type: 'string',
        description:
          'Optional specific question about the image. Default: "Describe this image in detail"',
      },
      detail: {
        type: 'string',
        enum: ['low', 'high', 'auto'],
        description:
          'Detail level for vision processing. Use "low" for simple diagrams, "high" for detailed screenshots.',
        default: 'auto',
      },
    },
    required: ['source'],
  },
  examples: [
    {
      name: 'vision_analyze',
      arguments: {
        source: 'screenshots/dashboard.png',
        prompt: 'What metrics are shown on this dashboard?',
      },
    },
    { name: 'vision_analyze', arguments: { source: 'diagram.png', detail: 'high' } },
  ],
  category: 'multimodal',
};

export class VisionAnalyzeTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = true;
  isReadOnly = true;
  timeout = 60000;
  maxOutputSize = 16000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const source = String(args.source ?? '');
    const prompt = String(args.prompt ?? 'Describe this image in detail');
    const detail = String(args.detail ?? 'auto');

    if (!source) return 'Error: No image source provided. Provide a file path or data URL.';

    try {
      let imageData: string;
      let mediaType = 'image/png';

      if (source.startsWith('data:')) {
        const match = source.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) return 'Error: Invalid data URL format. Expected: data:image/...;base64,...';
        mediaType = match[1];
        imageData = match[2];
      } else {
        const fs = await import('fs');
        const pathModule = await import('path');
        const { safePath } = await import('../fileSystemTool');
        let resolved: string;
        try {
          resolved = safePath(source);
        } catch (err) {
          console.warn('[Catch]', err);
          return `Error: Access denied: path "${source}" is outside workspace`;
        }
        if (!fs.existsSync(resolved)) return `Error: File not found: ${source}`;
        const buffer = fs.readFileSync(resolved);
        const ext = pathModule.extname(resolved).toLowerCase();
        const mediaTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp',
        };
        mediaType = mediaTypes[ext] ?? 'image/png';
        const maxSize = 20 * 1024 * 1024;
        if (buffer.length > maxSize)
          return `Error: Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Max: 20MB.`;
        imageData = buffer.toString('base64');
      }

      const body = {
        model: process.env.VISION_MODEL ?? 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:${mediaType};base64,${imageData}`, detail },
              },
            ],
          },
        ],
        max_tokens: 4096,
      };

      const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (!apiKey)
        return 'Error: No API key configured. Set VISION_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.';

      const baseUrl = process.env.VISION_BASE_URL ?? 'https://api.openai.com/v1';
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        return `Vision API error (${response.status}): ${text.slice(0, 500)}`;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? 'No analysis returned.';
    } catch (err: unknown) {
      return `Vision analysis failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
