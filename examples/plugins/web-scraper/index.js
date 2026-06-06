/**
 * Web Scraper Plugin — Advanced Web Data Extraction
 *
 * Demonstrates:
 *   - Multiple tool registration
 *   - Plugin configuration (configSchema)
 *   - Hook-based request logging
 *   - Error handling patterns
 *
 * Install:
 *   commander plugin install ./examples/plugins/web-scraper
 *
 * Tools provided:
 *   - scrape_page: Fetch a page and extract text/links/images
 *   - extract_table: Extract tabular data from a webpage
 */
const { createPlugin, defineTool, schema, stringProperty, numberProperty, booleanProperty } = require('@commander/plugin-sdk');

module.exports = createPlugin({
  id: 'web-scraper',
  name: 'Web Scraper Plugin',
  version: '1.0.0',
  description: 'Advanced web scraping tools',
  keywords: ['web', 'scraping'],

  async register(api) {
    const userAgent = api.config.userAgent || 'Commander-Plugin/1.0';
    const timeout = api.config.timeout || 30000;

    // ── Tool: scrape_page ──
    api.registerTool(defineTool({
      name: 'scrape_page',
      description: 'Fetch a webpage and extract structured data (text, links, images). Use when you need to scrape or extract content from a specific URL.',
      inputSchema: schema({
        url: stringProperty('The URL to scrape', {}),
        extract: {
          type: 'string',
          description: 'What to extract: "text" (default), "links", "images", "all"',
          enum: ['text', 'links', 'images', 'all'],
          default: 'text',
        },
        selector: stringProperty('Optional CSS selector to narrow extraction'),
      }, ['url']),
      async execute(args) {
        const { url, extract = 'text', selector } = args;

        api.logger.info(`Scraping: ${url} (extract=${extract})`);

        // In a real plugin, you'd use a proper scraping library
        // This is a simplified example
        try {
          const response = await fetch(url as string, {
            headers: { 'User-Agent': userAgent as string },
            signal: AbortSignal.timeout(timeout),
          });

          if (!response.ok) {
            return JSON.stringify({ error: `HTTP ${response.status}: ${response.statusText}` });
          }

          const html = await response.text();

          // Simple extraction (real plugin would use cheerio/puppeteer)
          const result = {
            url,
            status: response.status,
            contentType: response.headers.get('content-type'),
            bodyLength: html.length,
            extract,
            // Placeholder — real implementation would parse HTML
            data: `[Extracted ${extract} data from ${url}]`,
          };

          return JSON.stringify(result, null, 2);
        } catch (err) {
          return JSON.stringify({ error: `Failed to scrape ${url}: ${err.message}` });
        }
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      timeout: 60000,
      category: 'web',
    }));

    // ── Tool: extract_table ──
    api.registerTool(defineTool({
      name: 'extract_table',
      description: 'Extract tabular data from a webpage as structured JSON. Use when you need to get data from HTML tables.',
      inputSchema: schema({
        url: stringProperty('The URL containing the table', {}),
        tableIndex: numberProperty('Which table to extract (0-indexed)', { default: 0, minimum: 0 }),
      }, ['url']),
      async execute(args) {
        const { url, tableIndex = 0 } = args;

        api.logger.info(`Extracting table #${tableIndex} from: ${url}`);

        // Placeholder implementation
        return JSON.stringify({
          url,
          tableIndex,
          headers: ['Column 1', 'Column 2', 'Column 3'],
          rows: [
            ['Row 1, Col 1', 'Row 1, Col 2', 'Row 1, Col 3'],
            ['Row 2, Col 1', 'Row 2, Col 2', 'Row 2, Col 3'],
          ],
          note: 'This is a placeholder. Real implementation would parse HTML tables.',
        }, null, 2);
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      timeout: 60000,
      category: 'web',
    }));

    // ── Hook: Log all web tool calls ──
    api.on('beforeToolCall', async (ctx) => {
      if (ctx.toolName.startsWith('web-scraper__')) {
        api.logger.debug(`[${ctx.toolName}] Called with: ${JSON.stringify(ctx.args).slice(0, 200)}`);
      }
    });

    api.on('afterToolCall', async (ctx) => {
      if (ctx.toolName.startsWith('web-scraper__')) {
        api.logger.info(`[${ctx.toolName}] Completed in ${ctx.result.durationMs}ms`);
      }
    });

    api.logger.info('Web Scraper plugin loaded');
  },

  async unregister() {
    // Cleanup resources if needed
  },
});
