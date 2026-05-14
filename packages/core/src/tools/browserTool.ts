/**
 * Web search tool using Bing HTML search (no API key needed).
 * Falls back to fetching and parsing search engine results pages.
 */
import type { Tool, ToolDefinition } from '../runtime/types';

async function searchBing(query: string, count: number): Promise<string> {
  // Use DuckDuckGo lite HTML (simpler, English by default, no JS needed)
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) return '';
  const html = await res.text();

  // Parse search results from Bing HTML
  const results: string[] = [];
  let pos = 0;
  const searchEl = '<li class="b_algo';
  let found = 0;
  while (found < count) {
    const startIdx = html.indexOf(searchEl, pos);
    if (startIdx < 0) break;
    const endIdx = html.indexOf('</li>', startIdx);
    if (endIdx < 0) break;
    const block = html.slice(startIdx, endIdx + 5);

    // Extract title and link from <h2><a href="...">title</a></h2>
    const aStart = block.indexOf('<a ');
    const aEnd = aStart >= 0 ? block.indexOf('</a>', aStart) : -1;
    if (aStart < 0 || aEnd < 0) { pos = endIdx; continue; }
    const aTag = block.slice(aStart, aEnd + 4);
    const hrefMatch = aTag.match(/href="([^"]*)"/);
    const link = hrefMatch ? hrefMatch[1].replace(/&amp;/g, '&') : '';
    const title = aTag.replace(/<[^>]*>/g, '').trim();
    if (!title) { pos = endIdx; continue; }

    // Extract snippet from <p class="b_lineclamp...">
    const pStart = block.indexOf('<p');
    const pEnd = pStart >= 0 ? block.indexOf('</p>', pStart) : -1;
    let snippet = '';
    if (pStart >= 0 && pEnd >= 0) {
      snippet = block.slice(pStart, pEnd + 4).replace(/<[^>]*>/g, '').trim();
    }

    results.push(`${found + 1}. ${title}`);
    if (snippet) results.push(`   ${snippet.slice(0, 300)}`);
    if (link) results.push(`   ${link}`);
    found++;
    pos = endIdx;
  }

  return results.length > 0 ? results.join('\n') : '';
}

const DEFINITION: ToolDefinition = {
  name: 'browser_search',
  description: 'Search the web using Bing. No API key needed. Returns titles, snippets, and links.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'number', description: 'Number of results (1-10, default 5)' },
    },
    required: ['query'],
  },
};

export class BrowserSearchTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query || '');
    const count = Math.min(10, Math.max(1, Number(args.count) || 5));

    try {
      const result = await searchBing(query, count);
      if (result) {
        return `Search results for "${query}":\n${result}`;
      }
      return `No search results found for "${query}". Try a different query.`;
    } catch (err: any) {
      return `Search failed: ${err.message || 'Unknown error'}.`;
    }
  }
}

export class BrowserFetchTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'browser_fetch',
    description: 'Fetch and read the content of a webpage using a browser. Extracts the main text content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' },
      },
      required: ['url'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url || '');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return `Invalid URL: ${url}. URL must start with http:// or https://.`;
    }

    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      });
      const page = await context.newPage();

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);

      // Extract readable content
      const content = await page.evaluate(() => {
        // Remove scripts, styles, nav, footer
        const removes = document.querySelectorAll('script, style, nav, footer, header, iframe, .sidebar, .menu, .advertisement');
        removes.forEach(el => el.remove());

        // Try to get main content
        const main = document.querySelector('main, article, .content, #content, .post, .article') || document.body;
        const text = main.textContent || '';
        return text.replace(/\s+/g, ' ').trim().slice(0, 8000);
      });

      await browser.close();

      if (!content || content.length < 20) {
        return `Page at ${url} has no readable content.`;
      }

      return `Content from ${url}:\n${content.slice(0, 6000)}`;
    } catch (err: any) {
      return `Failed to fetch ${url}: ${err.message || 'Unknown error'}`;
    }
  }
}
