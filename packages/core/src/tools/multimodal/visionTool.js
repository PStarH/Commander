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
exports.VisionAnalyzeTool = void 0;
const DEFINITION = {
    name: 'vision_analyze',
    description: 'Analyze an image file (screenshot, diagram, UI mockup, chart). Accepts a file path or base64 data URL. Returns a text description of the image contents.',
    inputSchema: {
        type: 'object',
        properties: {
            source: {
                type: 'string',
                description: 'File path to image or base64 data URL (data:image/...;base64,...)',
            },
            prompt: {
                type: 'string',
                description: 'Optional specific question about the image. Default: "Describe this image in detail"',
            },
            detail: {
                type: 'string',
                enum: ['low', 'high', 'auto'],
                description: 'Detail level for vision processing. Use "low" for simple diagrams, "high" for detailed screenshots.',
                default: 'auto',
            },
        },
        required: ['source'],
    },
    examples: [
        {
            name: 'vision_analyze',
            arguments: {
                source: 'screenshots/dashboard.png',
                prompt: 'What metrics are shown on this dashboard?',
            },
        },
        { name: 'vision_analyze', arguments: { source: 'diagram.png', detail: 'high' } },
    ],
    category: 'multimodal',
};
class VisionAnalyzeTool {
    constructor() {
        this.definition = DEFINITION;
        this.isConcurrencySafe = true;
        this.isReadOnly = true;
        this.timeout = 60000;
        this.maxOutputSize = 16000;
    }
    async execute(args) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        const source = String((_a = args.source) !== null && _a !== void 0 ? _a : '');
        const prompt = String((_b = args.prompt) !== null && _b !== void 0 ? _b : 'Describe this image in detail');
        const detail = String((_c = args.detail) !== null && _c !== void 0 ? _c : 'auto');
        if (!source)
            return 'Error: No image source provided. Provide a file path or data URL.';
        try {
            let imageData;
            let mediaType = 'image/png';
            if (source.startsWith('data:')) {
                const match = source.match(/^data:(image\/\w+);base64,(.+)$/);
                if (!match)
                    return 'Error: Invalid data URL format. Expected: data:image/...;base64,...';
                mediaType = match[1];
                imageData = match[2];
            }
            else {
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                const pathModule = await Promise.resolve().then(() => __importStar(require('path')));
                const { safePath } = await Promise.resolve().then(() => __importStar(require('../fileSystemTool')));
                let resolved;
                try {
                    resolved = safePath(source);
                }
                catch {
                    return `Error: Access denied: path "${source}" is outside workspace`;
                }
                if (!fs.existsSync(resolved))
                    return `Error: File not found: ${source}`;
                const buffer = fs.readFileSync(resolved);
                const ext = pathModule.extname(resolved).toLowerCase();
                const mediaTypes = {
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.webp': 'image/webp',
                    '.svg': 'image/svg+xml',
                    '.bmp': 'image/bmp',
                };
                mediaType = (_d = mediaTypes[ext]) !== null && _d !== void 0 ? _d : 'image/png';
                const maxSize = 20 * 1024 * 1024;
                if (buffer.length > maxSize)
                    return `Error: Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Max: 20MB.`;
                imageData = buffer.toString('base64');
            }
            const body = {
                model: (_e = process.env.VISION_MODEL) !== null && _e !== void 0 ? _e : 'gpt-4o',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            {
                                type: 'image_url',
                                image_url: { url: `data:${mediaType};base64,${imageData}`, detail },
                            },
                        ],
                    },
                ],
                max_tokens: 4096,
            };
            const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
            if (!apiKey)
                return 'Error: No API key configured. Set VISION_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.';
            const baseUrl = (_f = process.env.VISION_BASE_URL) !== null && _f !== void 0 ? _f : 'https://api.openai.com/v1';
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const text = await response.text();
                return `Vision API error (${response.status}): ${text.slice(0, 500)}`;
            }
            const data = (await response.json());
            return (_k = (_j = (_h = (_g = data.choices) === null || _g === void 0 ? void 0 : _g[0]) === null || _h === void 0 ? void 0 : _h.message) === null || _j === void 0 ? void 0 : _j.content) !== null && _k !== void 0 ? _k : 'No analysis returned.';
        }
        catch (err) {
            return `Vision analysis failed: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
exports.VisionAnalyzeTool = VisionAnalyzeTool;
