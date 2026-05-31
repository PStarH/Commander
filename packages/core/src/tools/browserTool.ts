import type { Tool, ToolDefinition } from '../runtime/types';

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

// SECURITY FIX: blocklist for SSRF prevention
const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0',
  '169.254.169.254',  // AWS metadata
  'metadata.google.internal',  // GCP metadata
]);
const BLOCKED_CIDRS = [/^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./, /^169\.254\./];

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (BLOCKED_HOSTS.has(parsed.hostname)) return true;
    if (BLOCKED_CIDRS.some(re => re.test(parsed.hostname))) return true;
    // Block non-standard ports commonly used for internal services
    const port = parsed.port ? parseInt(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    if ([6379, 27017, 5432, 9200, 11211, 8500, 8300, 8501].includes(port)) return true;
    return false;
  } catch { return true; } // block unparseable URLs
}

async function acquireBrowserSlot(): Promise<void> {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return;
  }
  await new Promise<void>(resolve => browserQueue.push(resolve));
  activeBrowsers++;
}

function releaseBrowserSlot(): void {
  activeBrowsers--;
  if (browserQueue.length > 0) {
    const next = browserQueue.shift()!;
    next();
  }
}

async function getStealth() {
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

async function searchDDG(query: string, count: number): Promise<string> {
  await acquireBrowserSlot();
  const pe = await getStealth();
  const browser = await pe.launch({headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    await page.goto('https://duckduckgo.com/?q='+encodeURIComponent(query)+'&ia=web', {waitUntil:'networkidle',timeout:30000});
    await page.waitForTimeout(1500);

    const results = await page.evaluate((maxCount: number) => {
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
        items.push((i+1)+'. '+title);
        if (snip && snip.textContent) items.push('   '+snip.textContent.trim().slice(0,300));
        if (link) items.push('   '+(link as HTMLAnchorElement).href);
      }
      return items;
    }, count);

    return results.length > 0 ? 'Search results for "'+query+'":\n'+results.join('\n') : 'No results found.';
  } finally { await browser.close(); releaseBrowserSlot(); }
}

async function fetchPage(url: string): Promise<string> {
  // SECURITY FIX: SSRF prevention — block internal/private network access
  if (isBlockedUrl(url)) throw new Error(`Blocked: ${url} targets internal/private network`);
  await acquireBrowserSlot();
  const pe = await getStealth();
  const browser = await pe.launch({headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    await page.goto(url, {waitUntil:'networkidle',timeout:30000});
    await page.waitForTimeout(1000);
     const content = await page.evaluate((arg: undefined) => {
       for (const s of ['script','style','nav','footer','header','aside','iframe']) {
         document.querySelectorAll(s).forEach(e => e.remove());
       }
       const m = document.querySelector('main,article,.content,#content,.post')||document.body;
       return (m.textContent||'').replace(/\s+/g,' ').trim().slice(0,10000);
     }, undefined);
    return content || 'No readable content.';
  } finally { await browser.close(); releaseBrowserSlot(); }
}

const SDEF: ToolDefinition = {
  name:'browser_search',
  description:'Search the web via headless browser (DuckDuckGo). Renders JavaScript, handles dynamic content. Best for: pages that require JS rendering, sites that block API scrapers. Use web_search for faster API-based lookups.',
  inputSchema:{type:'object',properties:{
    query:{type:'string',description:'Search query'},
    count:{type:'number',description:'Results (1-10, default 5)'},
  },required:['query']},
  examples:[
    {name:'browser_search',arguments:{query:'React 19 release date'}},
    {name:'browser_search',arguments:{query:'TypeScript best practices 2026',count:3}},
  ],
  category:'web',
};

export class BrowserSearchTool implements Tool {
  readonly definition = SDEF;
  isReadOnly = true;
  isConcurrencySafe = true;
  timeout = 60000;
  maxOutputSize = 50000;
  async execute(args: Record<string,unknown>): Promise<string> {
    try { return await searchDDG(String(args.query||''), Math.min(10,Math.max(1,Number(args.count)||5))); }
    catch(err) { return 'Search failed: '+(err instanceof Error ? err.message : 'Unknown error'); }
  }
}

const FDEF: ToolDefinition = {
  name:'browser_fetch',
  description:'Fetch webpage content using a browser. Renders JavaScript and extracts main readable text. Best for: SPAs, JS-heavy sites, pages behind client-side rendering. Use web_fetch for simpler server-rendered pages.',
  inputSchema:{type:'object',properties:{
    url:{type:'string',description:'Full URL'},
  },required:['url']},
  examples:[
    {name:'browser_fetch',arguments:{url:'https://example.com'}},
    {name:'browser_fetch',arguments:{url:'https://news.ycombinator.com'}},
  ],
  category:'web',
};

export class BrowserFetchTool implements Tool {
  readonly definition = FDEF;
  isReadOnly = true;
  isConcurrencySafe = true;
  timeout = 60000;
  maxOutputSize = 50000;
  async execute(args: Record<string,unknown>): Promise<string> {
    const url = String(args.url||'');
    if (!url.startsWith('http://')&&!url.startsWith('https://')) return 'Invalid URL. Must start with http:// or https://.';
    try { return 'Content from '+url+':\n'+await fetchPage(url); }
    catch(err) { return 'Failed to fetch '+url+': '+(err instanceof Error ? err.message : 'Unknown error'); }
  }
}
