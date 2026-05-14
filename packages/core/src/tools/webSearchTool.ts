import type { Tool, ToolDefinition } from '../runtime/types';

export class WebSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'web_search',
    description: 'Search the web for current information. Returns relevant snippets and URLs. Use for fact-checking, research, and finding up-to-date information.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        numResults: { type: 'number', description: 'Number of results to return (default: 5)', default: 5 },
      },
      required: ['query'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    const numResults = Math.min(Number(args.numResults ?? 5), 10);

    if (!query) return 'Error: query is required';

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CommanderBot; +https://github.com/sampan/commander)' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const html = await response.text();
      const results = this.parseDuckDuckGo(html, numResults);

      if (results.length === 0) {
        return `No results found for "${query}". Try a different query.`;
      }

      return results.map((r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}\n`
      ).join('\n');
    } catch (err) {
      return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private parseDuckDuckGo(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const titleRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
    const urlRegex = /<a[^>]*class="result__url"[^>]*href="([^"]*)"[^>]*>/g;
    const snippetRegex = /(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<span[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/span>)/g;

    const titles: string[] = [];
    const urls: string[] = [];
    const snippets: string[] = [];

    let m;
    while ((m = titleRegex.exec(html)) !== null && titles.length < maxResults) {
      titles.push(m[1].replace(/<[^>]*>/g, '').trim());
    }
    while ((m = urlRegex.exec(html)) !== null && urls.length < maxResults) {
      urls.push(m[1]);
    }
    while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
      snippets.push((m[1] || m[2] || '').replace(/<[^>]*>/g, '').trim());
    }

    const count = Math.min(titles.length, urls.length, snippets.length, maxResults);
    for (let i = 0; i < count; i++) {
      results.push({ title: titles[i], url: urls[i], snippet: snippets[i] });
    }

    if (results.length === 0) {
      const fallbackRegex = /<a[^>]*class="[^"]*result[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = fallbackRegex.exec(html)) !== null && results.length < maxResults) {
        results.push({
          title: m[2].replace(/<[^>]*>/g, '').trim(),
          url: m[1],
          snippet: '',
        });
      }
    }
    return results;
  }
}

export class WebFetchTool implements Tool {
  definition: ToolDefinition = {
    name: 'web_fetch',
    description: 'Fetch and read the content of a webpage. Returns the text content. Use to read articles, documentation, and web pages.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        maxChars: { type: 'number', description: 'Maximum characters to return (default: 5000)', default: 5000 },
      },
      required: ['url'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    const maxChars = Math.min(Number(args.maxChars ?? 5000), 20000);

    if (!url) return 'Error: url is required';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CommanderBot; +https://github.com/sampan/commander)' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const html = await response.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      return text.slice(0, maxChars) + (text.length > maxChars ? '\n\n[Content truncated...]' : '');
    } catch (err) {
      return `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
