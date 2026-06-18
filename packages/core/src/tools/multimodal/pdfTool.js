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
exports.PdfExtractTool = void 0;
const DEFINITION = {
    name: 'pdf_extract',
    description: 'Extract text content from a PDF file. Returns the textual content page by page. Useful for reading reports, papers, documentation in PDF format.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or relative path to the PDF file' },
            pageStart: { type: 'number', description: 'First page to extract (1-indexed, default: 1)' },
            pageEnd: { type: 'number', description: 'Last page to extract (default: all pages)' },
            maxChars: { type: 'number', description: 'Maximum characters to return (default: 50000)' },
        },
        required: ['path'],
    },
    examples: [
        { name: 'pdf_extract', arguments: { path: 'docs/report.pdf' } },
        { name: 'pdf_extract', arguments: { path: 'paper.pdf', pageStart: 3, pageEnd: 5 } },
    ],
    category: 'multimodal',
};
class PdfExtractTool {
    constructor() {
        this.definition = DEFINITION;
        this.isConcurrencySafe = true;
        this.isReadOnly = true;
        this.timeout = 120000;
        this.maxOutputSize = 100000;
    }
    async execute(args) {
        var _a, _b, _c;
        const filePath = String((_a = args.path) !== null && _a !== void 0 ? _a : '');
        const pageStart = Number((_b = args.pageStart) !== null && _b !== void 0 ? _b : 1);
        const pageEnd = args.pageEnd !== undefined ? Number(args.pageEnd) : Infinity;
        const maxChars = Number((_c = args.maxChars) !== null && _c !== void 0 ? _c : 50000);
        if (!filePath)
            return 'Error: No file path provided.';
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs')));
            const pathModule = await Promise.resolve().then(() => __importStar(require('path')));
            const { safePath } = await Promise.resolve().then(() => __importStar(require('../fileSystemTool')));
            let resolved;
            try {
                resolved = safePath(filePath);
            }
            catch {
                return `Error: Access denied: path "${filePath}" is outside workspace`;
            }
            if (!fs.existsSync(resolved))
                return `Error: File not found: ${filePath}`;
            const stat = fs.statSync(resolved);
            if (!stat.isFile())
                return `Error: Not a file: ${filePath}`;
            if (stat.size > 100 * 1024 * 1024)
                return `Error: PDF too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 100MB.`;
            const ext = pathModule.extname(resolved).toLowerCase();
            if (ext !== '.pdf')
                return `Error: Not a PDF file: ${filePath}`;
            try {
                const pdfMod = 'pdfjs-dist';
                const pdflib = await Promise.resolve(`${pdfMod}`).then(s => __importStar(require(s)));
                const data = new Uint8Array(fs.readFileSync(resolved));
                const doc = await pdflib.getDocument({ data }).promise;
                const totalPages = doc.numPages;
                const endPage = Math.min(pageEnd, totalPages);
                const pages = [];
                for (let i = pageStart; i <= endPage; i++) {
                    const page = await doc.getPage(i);
                    const content = await page.getTextContent();
                    const text = content.items.map((item) => item.str).join(' ');
                    pages.push(`--- Page ${i}/${totalPages} ---\n${text}`);
                }
                await doc.destroy();
                const result = pages.join('\n\n');
                if (result.length <= maxChars)
                    return result;
                return `${result.slice(0, maxChars)}\n\n...[Truncated at ${maxChars} chars (${result.length} total)]`;
            }
            catch (err) {
                const innerMsg = err instanceof Error ? err.message : String(err);
                if (innerMsg.includes('Cannot find module')) {
                    return `PDF extraction requires pdfjs-dist. Install: npm install pdfjs-dist\n\nError: ${innerMsg}`;
                }
                throw err;
            }
        }
        catch (err) {
            return `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
exports.PdfExtractTool = PdfExtractTool;
