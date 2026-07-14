import { reportSilentFailure } from '../../silentFailureReporter';
import type { Tool, ToolDefinition } from '../../runtime/types';
import { isUrlSafe } from '../_utils/urlSafety';
import { promises as dnsPromises } from 'node:dns';

/**
 * SBX-4: SSRF defense. Returns true if an IP literal is loopback, private, or
 * link-local (incl. the cloud metadata range) — used to re-check DNS-resolved
 * addresses so a public hostname that resolves to an internal IP is still blocked.
 */
function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, ''); // unwrap IPv4-mapped IPv6
  if (v === '0.0.0.0' || /^127\./.test(v)) return true;
  if (/^10\./.test(v)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true; // link-local / cloud metadata
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // IPv6 ULA
  return false;
}

const DEFINITION: ToolDefinition = {
  name: 'screenshot_capture',
  description:
    'Capture a screenshot of the current screen, a specific window, or a URL. Returns the screenshot as a file path. Use with vision_analyze to describe the screenshot contents.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'URL to capture (opens in headless browser). If empty, captures the screen or active window.',
      },
      outputPath: {
        type: 'string',
        description:
          'Where to save the screenshot file. Default: ./screenshots/screenshot-{timestamp}.png',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to capture a specific element on the page (only with URL mode).',
      },
      width: { type: 'number', description: 'Viewport width in pixels (default: 1280)' },
      height: { type: 'number', description: 'Viewport height in pixels (default: 720)' },
      fullPage: {
        type: 'boolean',
        description: 'Capture full page (scrolling) if true (default: false)',
      },
    },
  },
  examples: [
    { name: 'screenshot_capture', arguments: { url: 'https://example.com' } },
    {
      name: 'screenshot_capture',
      arguments: { url: 'https://github.com', fullPage: true, width: 1920 },
    },
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
    const path = await import('path');
    const crypto = await import('crypto');

    const { safePath } = await import('../fileSystemTool');
    const outputPath = String(args.outputPath ?? '');
    // Validate output path: reject shell metacharacters to prevent injection (P1-15)
    if (outputPath && /[;&|`$(){}[\]!#~<>*\n\t'"\\]/.test(outputPath)) {
      return `Error: outputPath contains shell-unsafe characters`;
    }
    let resolvedPath: string;
    if (outputPath) {
      try {
        resolvedPath = await safePath(outputPath);
      } catch (err) {
        reportSilentFailure(err, 'screenshotTool:67');
        return `Error: Access denied: path "${outputPath}" is outside workspace`;
      }
    } else {
      // Default: save in workspace with unique filename
      const hash = crypto.randomBytes(4).toString('hex');
      resolvedPath = await safePath(`screenshots/screenshot-${Date.now()}-${hash}.png`);
    }
    const outDir = path.dirname(resolvedPath);
    // mkdirAsync with recursive:true is idempotent — no need for a separate
    // existsSync guard. This collapses the original (existsSync + mkdirSync)
    // audit-flagged sync pair into a single non-blocking call.
    await (await import('fs')).promises.mkdir(outDir, { recursive: true });

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
    url: string,
    outputPath: string,
    opts: { width: number; height: number; fullPage: boolean; selector: string },
  ): Promise<string> {
    // SBX-4: SSRF guard. Reject non-http(s), localhost/private/link-local hosts,
    // and (against DNS rebinding) re-check every resolved IP before navigating.
    const safety = isUrlSafe(url);
    if (!safety.safe) {
      return `Error: refusing to capture unsafe URL (${safety.reason ?? 'blocked'}).`;
    }
    try {
      const resolved = await dnsPromises.lookup(new URL(url).hostname, { all: true });
      const blocked = resolved.find((r) => isPrivateAddress(r.address));
      if (blocked) {
        return `Error: refusing to capture URL that resolves to a private/link-local address (${blocked.address}).`;
      }
    } catch (err) {
      return `Error: could not resolve URL host for safety check: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      const { chromium } = await import('playwright');
      // Chromium's own sandbox is a defense-in-depth layer; only disable it when an
      // operator explicitly opts in (e.g. running as root in a container).
      const launchArgs =
        process.env.COMMANDER_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
      const browser = await chromium.launch({ headless: true, args: launchArgs });
      const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      if (opts.selector) {
        const el = await page.$(opts.selector);
        if (!el) {
          await browser.close();
          return `Error: Element "${opts.selector}" not found on page.`;
        }
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
        const { execFileSync } = await import('child_process');
        execFileSync('screencapture', ['-x', outputPath], { timeout: 15000 });
        return `Screen capture saved: ${outputPath}`;
      }
      if (platform === 'linux') {
        const { execFileSync } = await import('child_process');
        execFileSync('import', ['-window', 'root', outputPath], { timeout: 15000 });
        return `Screen capture saved: ${outputPath}`;
      }
      return `Screen capture not supported on ${platform}. Use URL mode or provide a file path.`;
    } catch (err: unknown) {
      return `Screenshot failed: ${err instanceof Error ? err.message : String(err)}. Try URL mode instead.`;
    }
  }
}
