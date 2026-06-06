import type { Tool, ToolDefinition } from '../runtime/types';
import { isUrlSafe } from './_utils/urlSafety';

interface StealthPlaywright {
  launch(opts: Record<string, unknown>): Promise<StealthBrowser>;
}
interface StealthBrowser {
  newPage(opts: Record<string, unknown>): Promise<StealthPage>;
  close(): Promise<void>;
}
interface StealthPage {
  goto(url: string, opts: Record<string, unknown>): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  close(): Promise<void>;
}

let stealthBrowser: StealthPlaywright | null = null;
const MAX_CONCURRENT_BROWSERS = 3;
let activeBrowsers = 0;
const browserQueue: Array<() => void> = [];

function acquireBrowserSlot(): Promise<void> {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    browserQueue.push(resolve);
  }).then(() => {
    activeBrowsers++;
  });
}

function releaseBrowserSlot(): void {
  activeBrowsers--;
  if (browserQueue.length > 0) {
    const next = browserQueue.shift();
    if (next) next();
  }
}

async function getStealth(): Promise<StealthPlaywright> {
  if (!stealthBrowser) {
    const { addExtra } = await import('playwright-extra');
    const { chromium } = await import('playwright');
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    const pe = addExtra(chromium);
    pe.use(StealthPlugin());
    stealthBrowser = pe as unknown as StealthPlaywright;
  }
  return stealthBrowser;
}

async function withBrowserPage<T>(fn: (page: StealthPage) => Promise<T>): Promise<T> {
  await acquireBrowserSlot();
  const pe = await getStealth();
  let browser: StealthBrowser;
  try {
    browser = await pe.launch({
      headless: true,
      args: process.env.CHROMIUM_NO_SANDBOX === 'true' ? ['--no-sandbox'] : [],
    });
  } catch (err) {
    releaseBrowserSlot();
    throw err;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      return await fn(page);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    releaseBrowserSlot();
  }
}

async function searchDDG(query: string, count: number): Promise<string> {
  const results = await withBrowserPage(async page => {
    await page.goto('https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&ia=web', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(1500);
    return page.evaluate((maxCount: number) => {
      const items: string[] = [];
      const articles = document.querySelectorAll('article[data-testid="result"]');
      for (let i = 0; i < Math.min(maxCount, articles.length); i++) {
        const a = articles[i];
        const h2 = a.querySelector('h2');
        const link = a.querySelector('a[href^="http"]');
        const snip = a.querySelector('[data-testid="result-snippet"]');
        if (!h2) continue;
        const title = h2.textContent?.trim();
        if (!title) continue;
        items.push((i + 1) + '. ' + title);
        if (snip && snip.textContent) items.push('   ' + snip.textContent.trim().slice(0, 300));
        if (link) items.push('   ' + (link as HTMLAnchorElement).href);
      }
      return items;
    }, count);
  });

  return results.length > 0
    ? 'Search results for "' + query + '":\n' + results.join('\n')
    : 'No results found.';
}

async function fetchPage(url: string): Promise<string> {
  const safety = isUrlSafe(url);
  if (!safety.safe) throw new Error(`Blocked: ${url} (${safety.reason})`);

  return withBrowserPage(async page => {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);
    return page.evaluate((arg: undefined) => {
      for (const s of ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe']) {
        document.querySelectorAll(s).forEach(e => e.remove());
      }
      const m = document.querySelector('main,article,.content,#content,.post') || document.body;
      return (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 10000);
    }, undefined);
  });
}

const SDEF: ToolDefinition = {
  name: 'browser_search',
  description: 'Search the web via headless browser (DuckDuckGo). Renders JavaScript, handles dynamic content. Best for: pages that require JS rendering, sites that block API scrapers. Use web_search for faster API-based lookups.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'number', description: 'Results (1-10, default 5)' },
    },
    required: ['query'],
  },
  examples: [
    { name: 'browser_search', arguments: { query: 'React 19 release date' } },
    { name: 'browser_search', arguments: { query: 'TypeScript best practices 2026', count: 3 } },
  ],
  category: 'web',
};

export class BrowserSearchTool implements Tool {
  readonly definition = SDEF;
  isReadOnly = true;
  isConcurrencySafe = true;
  timeout = 60000;
  maxOutputSize = 50000;
  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      return await searchDDG(String(args.query || ''), Math.min(10, Math.max(1, Number(args.count) || 5)));
    } catch (err) {
      return 'Search failed: ' + (err instanceof Error ? err.message : 'Unknown error');
    }
  }
}

const FDEF: ToolDefinition = {
  name: 'browser_fetch',
  description: 'Fetch webpage content using a browser. Renders JavaScript and extracts main readable text. Best for: SPAs, JS-heavy sites, pages behind client-side rendering. Use web_fetch for simpler server-rendered pages.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL' },
    },
    required: ['url'],
  },
  examples: [
    { name: 'browser_fetch', arguments: { url: 'https://example.com' } },
    { name: 'browser_fetch', arguments: { url: 'https://news.ycombinator.com' } },
  ],
  category: 'web',
};

export class BrowserFetchTool implements Tool {
  readonly definition = FDEF;
  isReadOnly = true;
  isConcurrencySafe = true;
  timeout = 60000;
  maxOutputSize = 50000;
  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url || '');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'Invalid URL. Must start with http:// or https://.';
    }
    try {
      return 'Content from ' + url + ':\n' + await fetchPage(url);
    } catch (err) {
      return 'Failed to fetch ' + url + ': ' + (err instanceof Error ? err.message : 'Unknown error');
    }
  }
}
