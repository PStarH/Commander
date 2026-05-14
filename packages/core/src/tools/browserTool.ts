import type { Tool, ToolDefinition } from '../runtime/types';

let stealthBrowser: any = null;
async function getStealth() {
  if (!stealthBrowser) {
    const { addExtra } = await import('playwright-extra');
    const { chromium } = await import('playwright');
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    const pe = addExtra(chromium);
    pe.use(StealthPlugin());
    stealthBrowser = pe;
  }
  return stealthBrowser;
}

async function searchDDG(query: string, count: number): Promise<string> {
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
  } finally { await browser.close(); }
}

async function fetchPage(url: string): Promise<string> {
  const pe = await getStealth();
  const browser = await pe.launch({headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    await page.goto(url, {waitUntil:'networkidle',timeout:30000});
    await page.waitForTimeout(1000);
    const content = await page.evaluate(() => {
      for (const s of ['script','style','nav','footer','header','aside','iframe']) {
        document.querySelectorAll(s).forEach(e => e.remove());
      }
      const m = document.querySelector('main,article,.content,#content,.post')||document.body;
      return (m.textContent||'').replace(/\s+/g,' ').trim().slice(0,10000);
    });
    return content || 'No readable content.';
  } finally { await browser.close(); }
}

const SDEF: ToolDefinition = {
  name:'browser_search',
  description:'Search the web (DuckDuckGo, no API key). Returns titles, URLs, snippets.',
  inputSchema:{type:'object',properties:{
    query:{type:'string',description:'Search query'},
    count:{type:'number',description:'Results (1-10, default 5)'},
  },required:['query']},
};

export class BrowserSearchTool implements Tool {
  readonly definition = SDEF;
  async execute(args: Record<string,unknown>): Promise<string> {
    try { return await searchDDG(String(args.query||''), Math.min(10,Math.max(1,Number(args.count)||5))); }
    catch(err:any) { return 'Search failed: '+(err.message||'Unknown error'); }
  }
}

const FDEF: ToolDefinition = {
  name:'browser_fetch',
  description:'Fetch webpage content using a browser. Extracts main readable text.',
  inputSchema:{type:'object',properties:{
    url:{type:'string',description:'Full URL'},
  },required:['url']},
};

export class BrowserFetchTool implements Tool {
  readonly definition = FDEF;
  async execute(args: Record<string,unknown>): Promise<string> {
    const url = String(args.url||'');
    if (!url.startsWith('http://')&&!url.startsWith('https://')) return 'Invalid URL. Must start with http:// or https://.';
    try { return 'Content from '+url+':\n'+await fetchPage(url); }
    catch(err:any) { return 'Failed to fetch '+url+': '+(err.message||'Unknown error'); }
  }
}
