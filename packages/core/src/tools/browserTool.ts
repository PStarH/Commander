import type { Tool, ToolDefinition } from '../runtime/types';

function decodeHtml(text: string): string {
  return text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/&#(\d+);/g,(_,c)=>String.fromCodePoint(Number(c)));
}
function stripHtml(h: string): string {
  return h.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}
function ddgBlocked(h: string): boolean {
  return /g-recaptcha|are you a human|challenge-form/i.test(h);
}

async function searchDuckDuckGo(query: string, count: number): Promise<string|null> {
  try {
    const url = 'https://html.duckduckgo.com/html?q='+encodeURIComponent(query)+'&kl=us-en&kp=-2';
    const res = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'}});
    if (!res.ok) return null;
    const html = await res.text();
    if (ddgBlocked(html)) return null;
    const results: string[] = [];
    const linkRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snipRe = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
    let m;
    while ((m = linkRe.exec(html)) !== null && results.length < count) {
      const title = decodeHtml(stripHtml(m[2]));
      if (!title) continue;
      const after = html.slice(m.index+m[0].length);
      const next = after.search(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"/i);
      const scope = next>=0 ? after.slice(0,next) : after;
      const sm = snipRe.exec(scope);
      const snippet = sm ? decodeHtml(stripHtml(sm[1])) : '';
      let url = m[1].replace(/&amp;/g,'&');
      try { const p = new URL(url.startsWith('//')?'https:'+url:url); const u=p.searchParams.get('uddg'); if(u) url=u; } catch {}
      results.push((results.length+1)+'. '+title);
      if (snippet) results.push('   '+snippet.slice(0,300));
      if (url) results.push('   '+url);
    }
    return results.length>0 ? 'Search results for "'+query+'":\n'+results.join('\n') : null;
  } catch { return null; }
}

async function searchBrave(query: string, count: number): Promise<string|null> {
  const apiKey = process.env.BRAVE_API_KEY||'';
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?q='+encodeURIComponent(query)+'&count='+count,
      {headers:{'Accept':'application/json','Accept-Encoding':'gzip','x-rapidapi-key':apiKey}});
    if (!res.ok) return null;
    const data: any = await res.json();
    const items = data.web?.results||[];
    if (!items.length) return null;
    const lines = ['Search results for "'+query+'":'];
    for (let i=0; i<Math.min(count,items.length); i++) {
      lines.push((i+1)+'. '+items[i].title);
      if (items[i].description) lines.push('   '+items[i].description.slice(0,300));
      if (items[i].url) lines.push('   '+items[i].url);
    }
    return lines.join('\n');
  } catch { return null; }
}

const DEF: ToolDefinition = {
  name:'browser_search',
  description:'Search the web. Returns titles, URLs, snippets. DuckDuckGo (free) or Brave Search if BRAVE_API_KEY set.',
  inputSchema:{type:'object',properties:{
    query:{type:'string',description:'Search query'},
    count:{type:'number',description:'Results (1-10, default 5)'},
  },required:['query']},
};

export class BrowserSearchTool implements Tool {
  readonly definition = DEF;
  async execute(args: Record<string,unknown>): Promise<string> {
    const query = String(args.query||'');
    const count = Math.min(10,Math.max(1,Number(args.count)||5));
    let r = await searchBrave(query,count);
    if (r) return r;
    r = await searchDuckDuckGo(query,count);
    if (r) return r;
    if (!process.env.BRAVE_API_KEY) {
      return 'Set BRAVE_API_KEY for free web search (2,000 queries/month). Sign up: https://brave.com/search/api/';
    }
    return 'Search failed. Try a different query.';
  }
}
