import type { Tool, ToolDefinition } from '../../runtime/types';

const DEFINITION: ToolDefinition = {
  name: 'screenshot_capture',
  description: 'Capture a screenshot of the current screen, a specific window, or a URL. Returns the screenshot as a file path. Use with vision_analyze to describe the screenshot contents.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to capture (opens in headless browser). If empty, captures the screen or active window.',
      },
      outputPath: {
        type: 'string',
        description: 'Where to save the screenshot file. Default: ./screenshots/screenshot-{timestamp}.png',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to capture a specific element on the page (only with URL mode).',
      },
      width: { type: 'number', description: 'Viewport width in pixels (default: 1280)' },
      height: { type: 'number', description: 'Viewport height in pixels (default: 720)' },
      fullPage: { type: 'boolean', description: 'Capture full page (scrolling) if true (default: false)' },
    },
  },
  examples: [
    { name: 'screenshot_capture', arguments: { url: 'https://example.com' } },
    { name: 'screenshot_capture', arguments: { url: 'https://github.com', fullPage: true, width: 1920 } },
  ],
  category: 'multimodal',
};

export class ScreenshotCaptureTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = false;
  isReadOnly = true;
  timeout = 60000;
  maxOutputSize = 5000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    const selector = String(args.selector ?? '');
    const width = Number(args.width ?? 1280);
    const height = Number(args.height ?? 720);
    const fullPage = Boolean(args.fullPage);
    const fs = await import('fs');
    const path = await import('path');
    const crypto = await import('crypto');

    const screenshotDir = path.resolve(process.cwd(), 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const hash = crypto.randomBytes(4).toString('hex');
    const outputPath = String(args.outputPath ?? path.join(screenshotDir, `screenshot-${Date.now()}-${hash}.png`));
    const resolvedPath = path.resolve(outputPath);
    const outDir = path.dirname(resolvedPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    try {
      if (url) {
        return await this.captureUrl(url, resolvedPath, { width, height, fullPage, selector });
      }
      return await this.captureScreen(resolvedPath);
    } catch (err: unknown) {
      return `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async captureUrl(
    url: string, outputPath: string, opts: { width: number; height: number; fullPage: boolean; selector: string },
  ): Promise<string> {
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      if (opts.selector) {
        const el = await page.$(opts.selector);
        if (!el) { await browser.close(); return `Error: Element "${opts.selector}" not found on page.`; }
        await el.screenshot({ path: outputPath });
      } else {
        await page.screenshot({ path: outputPath, fullPage: opts.fullPage });
      }
      await browser.close();
      return `Screenshot saved: ${outputPath} (${opts.width}x${opts.height})`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Cannot find module')) {
        return `URL screenshot requires playwright. Install: npm install playwright\n\nError: ${msg}`;
      }
      throw err;
    }
  }

  private async captureScreen(outputPath: string): Promise<string> {
    const os = await import('os');
    const platform = os.platform();
    try {
      if (platform === 'darwin') {
        const { execSync } = await import('child_process');
        execSync(`screencapture -x "${outputPath}"`, { timeout: 15000 });
        return `Screen capture saved: ${outputPath}`;
      }
      if (platform === 'linux') {
        const { execSync } = await import('child_process');
        execSync(`import -window root "${outputPath}"`, { timeout: 15000 });
        return `Screen capture saved: ${outputPath}`;
      }
      return `Screen capture not supported on ${platform}. Use URL mode or provide a file path.`;
    } catch (err: unknown) {
      return `Screen capture failed: ${err instanceof Error ? err.message : String(err)}. Try URL mode instead.`;
    }
  }
}
