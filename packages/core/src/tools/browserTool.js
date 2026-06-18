"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserFetchTool = exports.BrowserSearchTool = void 0;
const urlSafety_1 = require("./_utils/urlSafety");
let stealthBrowser = null;
const MAX_CONCURRENT_BROWSERS = 3;
let activeBrowsers = 0;
const browserQueue = [];
function acquireBrowserSlot() {
    if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
        activeBrowsers++;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        browserQueue.push(resolve);
    }).then(() => {
        activeBrowsers++;
    });
}
function releaseBrowserSlot() {
    activeBrowsers--;
    if (browserQueue.length > 0) {
        const next = browserQueue.shift();
        if (next)
            next();
    }
}
async function getStealth() {
    if (!stealthBrowser) {
        const { addExtra } = await Promise.resolve().then(() => __importStar(require('playwright-extra')));
        const { chromium } = await Promise.resolve().then(() => __importStar(require('playwright')));
        const StealthPlugin = (await Promise.resolve().then(() => __importStar(require('puppeteer-extra-plugin-stealth')))).default;
        const pe = addExtra(chromium);
        pe.use(StealthPlugin());
        stealthBrowser = pe;
    }
    return stealthBrowser;
}
async function withBrowserPage(fn) {
    await acquireBrowserSlot();
    const pe = await getStealth();
    let browser;
    try {
        browser = await pe.launch({
            headless: true,
            args: process.env.CHROMIUM_NO_SANDBOX === 'true' ? ['--no-sandbox'] : [],
        });
    }
    catch (err) {
        releaseBrowserSlot();
        throw err;
    }
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        try {
            return await fn(page);
        }
        finally {
            await page.close();
        }
    }
    finally {
        await browser.close();
        releaseBrowserSlot();
    }
}
async function searchDDG(query, count) {
    const results = await withBrowserPage(async (page) => {
        await page.goto('https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&ia=web', {
            waitUntil: 'networkidle',
            timeout: 30000,
        });
        await page.waitForTimeout(1500);
        return page.evaluate((maxCount) => {
            var _a;
            const items = [];
            const articles = document.querySelectorAll('article[data-testid="result"]');
            for (let i = 0; i < Math.min(maxCount, articles.length); i++) {
                const a = articles[i];
                const h2 = a.querySelector('h2');
                const link = a.querySelector('a[href^="http"]');
                const snip = a.querySelector('[data-testid="result-snippet"]');
                if (!h2)
                    continue;
                const title = (_a = h2.textContent) === null || _a === void 0 ? void 0 : _a.trim();
                if (!title)
                    continue;
                items.push(i + 1 + '. ' + title);
                if (snip && snip.textContent)
                    items.push('   ' + snip.textContent.trim().slice(0, 300));
                if (link)
                    items.push('   ' + link.href);
            }
            return items;
        }, count);
    });
    return results.length > 0
        ? 'Search results for "' + query + '":\n' + results.join('\n')
        : 'No results found.';
}
async function fetchPage(url) {
    const safety = (0, urlSafety_1.isUrlSafe)(url);
    if (!safety.safe)
        throw new Error(`Blocked: ${url} (${safety.reason})`);
    return withBrowserPage(async (page) => {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1000);
        return page.evaluate((arg) => {
            for (const s of ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe']) {
                document.querySelectorAll(s).forEach((e) => e.remove());
            }
            const m = document.querySelector('main,article,.content,#content,.post') || document.body;
            return (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 10000);
        }, undefined);
    });
}
const SDEF = {
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
class BrowserSearchTool {
    constructor() {
        this.definition = SDEF;
        this.isReadOnly = true;
        this.isConcurrencySafe = true;
        this.timeout = 60000;
        this.maxOutputSize = 50000;
    }
    async execute(args) {
        try {
            return await searchDDG(String(args.query || ''), Math.min(10, Math.max(1, Number(args.count) || 5)));
        }
        catch (err) {
            return 'Search failed: ' + (err instanceof Error ? err.message : 'Unknown error');
        }
    }
}
exports.BrowserSearchTool = BrowserSearchTool;
const FDEF = {
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
class BrowserFetchTool {
    constructor() {
        this.definition = FDEF;
        this.isReadOnly = true;
        this.isConcurrencySafe = true;
        this.timeout = 60000;
        this.maxOutputSize = 50000;
    }
    async execute(args) {
        const url = String(args.url || '');
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return 'Invalid URL. Must start with http:// or https://.';
        }
        try {
            return 'Content from ' + url + ':\n' + (await fetchPage(url));
        }
        catch (err) {
            return ('Failed to fetch ' + url + ': ' + (err instanceof Error ? err.message : 'Unknown error'));
        }
    }
}
exports.BrowserFetchTool = BrowserFetchTool;
