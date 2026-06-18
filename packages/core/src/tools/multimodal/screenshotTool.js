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
exports.ScreenshotCaptureTool = void 0;
const DEFINITION = {
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
class ScreenshotCaptureTool {
    constructor() {
        this.definition = DEFINITION;
        this.isConcurrencySafe = false;
        this.isReadOnly = true;
        this.timeout = 60000;
        this.maxOutputSize = 5000;
    }
    async execute(args) {
        var _a, _b, _c, _d, _e;
        const url = String((_a = args.url) !== null && _a !== void 0 ? _a : '');
        const selector = String((_b = args.selector) !== null && _b !== void 0 ? _b : '');
        const width = Number((_c = args.width) !== null && _c !== void 0 ? _c : 1280);
        const height = Number((_d = args.height) !== null && _d !== void 0 ? _d : 720);
        const fullPage = Boolean(args.fullPage);
        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
        const { safePath } = await Promise.resolve().then(() => __importStar(require('../fileSystemTool')));
        const hash = crypto.randomBytes(4).toString('hex');
        const outputPath = String((_e = args.outputPath) !== null && _e !== void 0 ? _e : '');
        // Validate output path: reject shell metacharacters to prevent injection (P1-15)
        if (outputPath && /[;&|`$(){}[\]!#~<>*\n\t'"\\]/.test(outputPath)) {
            return `Error: outputPath contains shell-unsafe characters`;
        }
        let resolvedPath;
        if (outputPath) {
            try {
                resolvedPath = safePath(outputPath);
            }
            catch {
                return `Error: Access denied: path "${outputPath}" is outside workspace`;
            }
        }
        else {
            // Default: save in workspace with unique filename
            const hash = crypto.randomBytes(4).toString('hex');
            resolvedPath = safePath(`screenshots/screenshot-${Date.now()}-${hash}.png`);
        }
        const outDir = path.dirname(resolvedPath);
        if (!fs.existsSync(outDir))
            fs.mkdirSync(outDir, { recursive: true });
        try {
            if (url) {
                return await this.captureUrl(url, resolvedPath, { width, height, fullPage, selector });
            }
            return await this.captureScreen(resolvedPath);
        }
        catch (err) {
            return `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
    async captureUrl(url, outputPath, opts) {
        try {
            const { chromium } = await Promise.resolve().then(() => __importStar(require('playwright')));
            const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
            const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
            if (opts.selector) {
                const el = await page.$(opts.selector);
                if (!el) {
                    await browser.close();
                    return `Error: Element "${opts.selector}" not found on page.`;
                }
                await el.screenshot({ path: outputPath });
            }
            else {
                await page.screenshot({ path: outputPath, fullPage: opts.fullPage });
            }
            await browser.close();
            return `Screenshot saved: ${outputPath} (${opts.width}x${opts.height})`;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Cannot find module')) {
                return `URL screenshot requires playwright. Install: npm install playwright\n\nError: ${msg}`;
            }
            throw err;
        }
    }
    async captureScreen(outputPath) {
        const os = await Promise.resolve().then(() => __importStar(require('os')));
        const platform = os.platform();
        try {
            if (platform === 'darwin') {
                const { execFileSync } = await Promise.resolve().then(() => __importStar(require('child_process')));
                execFileSync('screencapture', ['-x', outputPath], { timeout: 15000 });
                return `Screen capture saved: ${outputPath}`;
            }
            if (platform === 'linux') {
                const { execFileSync } = await Promise.resolve().then(() => __importStar(require('child_process')));
                execFileSync('import', ['-window', 'root', outputPath], { timeout: 15000 });
                return `Screen capture saved: ${outputPath}`;
            }
            return `Screen capture not supported on ${platform}. Use URL mode or provide a file path.`;
        }
        catch (err) {
            return `Screenshot failed: ${err instanceof Error ? err.message : String(err)}. Try URL mode instead.`;
        }
    }
}
exports.ScreenshotCaptureTool = ScreenshotCaptureTool;
