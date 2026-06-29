import { reportSilentFailure } from '../../silentFailureReporter';
import type { Tool, ToolDefinition } from '../../runtime/types';

const DEFINITION: ToolDefinition = {
  name: 'pdf_extract',
  description:
    'Extract text content from a PDF file. Returns the textual content page by page. Useful for reading reports, papers, documentation in PDF format.',
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

export class PdfExtractTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = true;
  isReadOnly = true;
  timeout = 120000;
  maxOutputSize = 100000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const pageStart = Number(args.pageStart ?? 1);
    const pageEnd = args.pageEnd !== undefined ? Number(args.pageEnd) : Infinity;
    const maxChars = Number(args.maxChars ?? 50000);

    if (!filePath) return 'Error: No file path provided.';

    const fs = await import('fs');
    const pathModule = await import('path');
    const { safePath } = await import('../fileSystemTool');

    try {
      let resolved: string;
      try {
        resolved = safePath(filePath);
      } catch (err) {
        reportSilentFailure(err, 'pdfTool:42');
        return `Error: Access denied: path "${filePath}" is outside workspace`;
      }

      // Single fs.promises.stat replaces {existsSync + statSync} — it both
      // checks existence and yields metadata, off the event loop.
      let stat;
      try {
        stat = await fs.promises.stat(resolved);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return `Error: File not found: ${filePath}`;
        }
        reportSilentFailure(err, 'pdfTool:54');
        return `Error: stat failed for ${filePath}: ${(err as Error).message}`;
      }
      if (!stat.isFile()) return `Error: Not a file: ${filePath}`;
      if (stat.size > 100 * 1024 * 1024)
        return `Error: PDF too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 100MB.`;

      const ext = pathModule.extname(resolved).toLowerCase();
      if (ext !== '.pdf') return `Error: Not a PDF file: ${filePath}`;

      try {
        const pdfMod = 'pdfjs-dist';
        const pdflib = await import(pdfMod);
        const raw = await fs.promises.readFile(resolved);
        const data = new Uint8Array(raw);
        const doc = await pdflib.getDocument({ data }).promise;
        const totalPages = doc.numPages;
        const endPage = Math.min(pageEnd, totalPages);
        const pages: string[] = [];

        for (let i = pageStart; i <= endPage; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const text = content.items.map((item: { str: string }) => item.str).join(' ');
          pages.push(`--- Page ${i}/${totalPages} ---\n${text}`);
        }

        await doc.destroy();
        const result = pages.join('\n\n');
        if (result.length <= maxChars) return result;
        return `${result.slice(0, maxChars)}\n\n...[Truncated at ${maxChars} chars (${result.length} total)]`;
      } catch (err: unknown) {
        const innerMsg = err instanceof Error ? err.message : String(err);
        if (innerMsg.includes('Cannot find module')) {
          return `PDF extraction requires pdfjs-dist. Install: npm install pdfjs-dist\n\nError: ${innerMsg}`;
        }
        throw err;
      }
    } catch (err: unknown) {
      return `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
