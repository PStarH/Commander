import type { Tool, ToolDefinition } from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { isUrlSafe } from './_utils/urlSafety';
import { safeFetch, SafeFetchError } from './_utils/httpClient';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

type SearchResult = { title: string; url: string; snippet: string };

export class WebSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'web_search',
    description:
      'Search the web for current information. Returns structured snippets and URLs. Best for: fact-checking, quick lookups, research queries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query. Be specific for better results.' },
        numResults: {
          type: 'number',
          description: 'Number of results to return (default: 5, max: 10)',
          default: 5,
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['query'],
    },
    examples: [
      { name: 'web_search', arguments: { query: 'latest TypeScript features 2026' } },
      {
        name: 'web_search',
        arguments: { query: 'microservices architecture best practices', numResults: 3 },
      },
    ],
    category: 'web',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    const numResults = Math.min(Number(args.numResults ?? 5), 10);
    if (!query) return 'Error: query is required';

    let results = await this.tryBing(query, numResults);
    if (!results) results = await this.tryDuckDuckGo(query, numResults);
    if (!results) results = await this.tryGoogle(query, numResults);

    if (!results || results.length === 0) {
      return `No results found for "${query}". Try a different query.`;
    }

    const filtered = results.filter((r) => isUrlSafe(r.url).safe);
    if (filtered.length === 0) {
      return `No results found for "${query}" (all URLs blocked by security policy).`;
    }

    return filtered
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}\n`)
      .join('\n');
  }

  private async tryDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[] | null> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const { body: html, status } = await safeFetch(url, {
        headers: {
          'User-Agent': CHROME_UA,
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (status !== 200) return null;
      if (
        html.includes('anomaly-modal') ||
        html.includes('challenge-form') ||
        html.includes('Unfortunately, bots')
      ) {
        getGlobalLogger().warn('WebSearchTool', 'DuckDuckGo returned CAPTCHA, skipping');
        return null;
      }
      const results = this.parseDuckDuckGo(html, maxResults);
      return results.length > 0 ? results : null;
    } catch (e) {
      getGlobalLogger().warn('WebSearchTool', 'DuckDuckGo search failed', {
        error: (e as Error)?.message,
        query,
      });
      return null;
    }
  }

  private async tryBing(query: string, maxResults: number): Promise<SearchResult[] | null> {
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=us&mkt=en-US&setlang=en`;
      const { body: html, status } = await safeFetch(url, {
        headers: {
          'User-Agent': CHROME_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie:
            'SRCHD=AF=NOFORM; SRCHHPGUSR=ADLT=MODERATE&NRSLT=10&SRCHLANG=en; _EDGE_S=mkt=en-us',
        },
      });
      if (status !== 200) return null;
      const results = this.parseBing(html, maxResults);
      return results.length > 0 ? results : null;
    } catch (e) {
      getGlobalLogger().warn('WebSearchTool', 'Bing search failed', {
        error: (e as Error)?.message,
        query,
      });
      return null;
    }
  }

  private async tryGoogle(query: string, maxResults: number): Promise<SearchResult[] | null> {
    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}&hl=en`;
      const { body: html, status } = await safeFetch(url, {
        headers: {
          'User-Agent': CHROME_UA,
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (status !== 200) return null;
      if (
        html.includes('captcha') ||
        html.includes('unusual traffic') ||
        html.includes('sorry/index')
      ) {
        getGlobalLogger().warn('WebSearchTool', 'Google returned CAPTCHA, skipping');
        return null;
      }
      const results = this.parseGoogle(html, maxResults);
      return results.length > 0 ? results : null;
    } catch (e) {
      getGlobalLogger().warn('WebSearchTool', 'Google search failed', {
        error: (e as Error)?.message,
        query,
      });
      return null;
    }
  }

  private parseGoogle(
    html: string,
    maxResults: number,
  ): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const linkRegex = /<a[^>]*href="\/url\?q=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<span[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    let match;
    const urls: string[] = [];
    const titles: string[] = [];

    while ((match = linkRegex.exec(html)) !== null && urls.length < maxResults) {
      const rawUrl = decodeURIComponent(match[1]);
      if (rawUrl.includes('google.com') || rawUrl.includes('youtube.com/results')) continue;
      urls.push(rawUrl);
      titles.push(match[2].replace(/<[^>]+>/g, '').trim());
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < urls.length) {
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text.length > 30 && !text.includes('Sign in') && !text.includes('Settings')) {
        snippets.push(text);
      }
    }

    for (let i = 0; i < urls.length; i++) {
      results.push({
        title: titles[i] || `Result ${i + 1}`,
        url: urls[i],
        snippet: snippets[i] || '',
      });
    }
    return results;
  }

  private parseDuckDuckGo(
    html: string,
    maxResults: number,
  ): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const titleRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
    const urlRegex = /<a[^>]*class="result__url"[^>]*href="([^"]*)"[^>]*>/g;
    const snippetRegex =
      /(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<span[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/span>)/g;

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
      const fallbackRegex =
        /<a[^>]*class="[^"]*result[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = fallbackRegex.exec(html)) !== null && results.length < maxResults) {
        results.push({ title: m[2].replace(/<[^>]*>/g, '').trim(), url: m[1], snippet: '' });
      }
    }
    if (results.length === 0) {
      const headingLinkRegex =
        /<h[1-4][^>]*>.*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>.*?<\/h[1-4]>/gi;
      while ((m = headingLinkRegex.exec(html)) !== null && results.length < maxResults) {
        results.push({ title: m[2].replace(/<[^>]*>/g, '').trim(), url: m[1], snippet: '' });
      }
    }
    if (results.length === 0) {
      const anyLinkRegex = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = anyLinkRegex.exec(html)) !== null && results.length < maxResults) {
        const text = m[2].replace(/<[^>]*>/g, '').trim();
        if (text) results.push({ title: text, url: m[1], snippet: '' });
      }
    }
    return results;
  }

  private parseBing(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];
    const blocks: string[] = [];
    let idx = 0;
    while (true) {
      const start = html.indexOf('<li class="b_algo"', idx);
      if (start === -1) break;
      const end = html.indexOf('</li>', start);
      if (end === -1) break;
      blocks.push(html.slice(start, end + 5));
      idx = end + 5;
    }
    for (const block of blocks) {
      if (results.length >= maxResults) break;
      const urlMatch = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a><\/h2>/);
      if (!urlMatch) continue;
      let url = urlMatch[1].replace(/&amp;/g, '&');
      const redirectMatch = url.match(/[?&]u=([^&]+)/);
      if (redirectMatch) {
        try {
          const encoded = redirectMatch[1].replace(/^a1/, '');
          url = Buffer.from(encoded, 'base64').toString('utf-8');
        } catch (err) {
          console.warn('[Catch]', err);
        }
      }
      const title = urlMatch[2].replace(/<[^>]*>/g, '').trim();
      const snipMatch =
        block.match(/<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) ??
        block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const snippet = snipMatch
        ? snipMatch[1]
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&#\d+;/g, '')
            .trim()
        : '';
      results.push({ title, url, snippet });
    }
    return results;
  }
}

export class WebFetchTool implements Tool {
  definition: ToolDefinition = {
    name: 'web_fetch',
    description:
      'Fetch and read the content of a webpage. Returns the text content. Use to read articles, documentation, and web pages.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        maxChars: {
          type: 'number',
          description: 'Maximum characters to return (default: 5000)',
          default: 5000,
        },
      },
      required: ['url'],
    },
    examples: [
      { name: 'web_fetch', arguments: { url: 'https://example.com' } },
      {
        name: 'web_fetch',
        arguments: { url: 'https://en.wikipedia.org/wiki/TypeScript', maxChars: 3000 },
      },
    ],
    category: 'web',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    const maxChars = Math.min(Number(args.maxChars ?? 5000), 20000);

    if (!url) return 'Error: url is required';

    const safety = isUrlSafe(url);
    if (!safety.safe) return `Blocked: ${url} (${safety.reason})`;

    try {
      const { body: html, truncated } = await safeFetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; CommanderBot; +https://github.com/sampan/commander)',
        },
      });

      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      let result = text.slice(0, maxChars);
      if (text.length > maxChars) result += '\n\n[Content truncated...]';
      if (truncated) result += '\n[Response body truncated by safety limit]';
      return result;
    } catch (err) {
      if (err instanceof SafeFetchError) {
        return `Failed to fetch ${url}: ${err.message}`;
      }
      return `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
