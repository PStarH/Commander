import { Router } from 'express';
import { contentScanner, ScanResult } from './contentScanner';
import { MemoryPoisoningDetector } from './memoryPoisoningDetector';
import { toErrorMessage } from './routeHelpers';

export function createSecurityRouter(): Router {
  const router = Router();
  const memoryPoisoningDetector = new MemoryPoisoningDetector();

  router.post('/api/security/scan', async (req, res) => {
    try {
      const { content, contentType } = req.body;
      if (!content) {
        return res.status(400).json({ error: 'Content is required' });
      }
      const result: ScanResult = await contentScanner.scan(content, contentType || 'text');
      res.json({
        safe: result.safe,
        threats: result.threats,
        sanitizedContent: result.sanitizedContent,
        confidence: result.confidence,
        summary: result.safe
          ? 'Content passed security scan'
          : `Found ${result.threats.length} potential threat(s)`,
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post('/api/security/scan/:contentType', async (req, res) => {
    try {
      const { contentType } = req.params;
      const { content } = req.body;
      if (!['html', 'markdown', 'text', 'json'].includes(contentType)) {
        return res.status(400).json({
          error: 'Invalid contentType. Must be one of: html, markdown, text, json',
        });
      }
      if (!content) {
        return res.status(400).json({ error: 'Content is required' });
      }
      const result: ScanResult = await contentScanner.scan(
        content,
        contentType as 'html' | 'markdown' | 'text' | 'json',
      );
      res.json({
        safe: result.safe,
        threats: result.threats,
        sanitizedContent: result.sanitizedContent,
        confidence: result.confidence,
        contentType,
        scannedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.get('/api/security/stats', (_req, res) => {
    res.json({
      service: 'ContentScanner',
      version: '1.0.0',
      threatTypes: [
        'hidden_html',
        'hidden_css',
        'metadata_injection',
        'prompt_injection',
        'javascript_url',
        'data_url',
        'svg_injection',
        'unicode_obfuscation',
      ],
      supportedContentTypes: ['html', 'markdown', 'text', 'json'],
      description: 'Agent Security Content Scanner based on arXiv:2510.23883v2',
    });
  });

  router.post('/api/memory/assess-credibility', async (req, res) => {
    const { id, content, timestamp, source, embedding, metadata } = req.body ?? {};
    if (!content || !source) {
      return res.status(400).json({ error: 'content and source are required' });
    }
    const result = await memoryPoisoningDetector.assessCredibility({
      id: id ?? `mem-${Date.now()}`,
      content,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      source,
      embedding,
      metadata,
    });
    res.json(result);
  });

  router.post('/api/memory/detect-poisoning', async (req, res) => {
    const { newMemories, existingMemories } = req.body ?? {};
    if (!Array.isArray(newMemories)) {
      return res.status(400).json({ error: 'newMemories array is required' });
    }
    const indicators = await memoryPoisoningDetector.detectPoisoning(
      newMemories.map((m: Record<string, unknown>) => ({
        id: (m.id as string) ?? `mem-${Date.now()}`,
        content: (m.content as string) ?? '',
        timestamp: m.timestamp ? new Date(m.timestamp as string) : new Date(),
        source: (m.source as string) ?? 'unknown',
        embedding: m.embedding as number[] | undefined,
        metadata: m.metadata as Record<string, unknown> | undefined,
      })),
      (existingMemories ?? []).map((m: Record<string, unknown>) => ({
        id: (m.id as string) ?? `mem-${Date.now()}`,
        content: (m.content as string) ?? '',
        timestamp: m.timestamp ? new Date(m.timestamp as string) : new Date(),
        source: (m.source as string) ?? 'unknown',
        embedding: m.embedding as number[] | undefined,
        metadata: m.metadata as Record<string, unknown> | undefined,
      })),
    );
    res.json({ indicators, count: indicators.length });
  });

  return router;
}
