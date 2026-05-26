import { Router } from 'express';
import { HallucinationDetector } from '@commander/core';
import { getConsistencyMonitorManager } from './consistencyMonitor';

export function createQualityRouter(): Router {
  const router = Router();
  const hallucinationDetector = new HallucinationDetector();

  router.post('/api/quality/hallucination-check', (req, res) => {
    const { input, output } = req.body;
    if (!input || !output) {
      return res.status(400).json({ error: 'Both input and output are required' });
    }
    const report = hallucinationDetector.analyze(
      typeof input === 'string' ? input : JSON.stringify(input),
      typeof output === 'string' ? output : JSON.stringify(output),
    );
    res.json(report);
  });

  router.get('/api/quality/hallucination-check/info', (_req, res) => {
    res.json({
      signals: [
        'overconfidence',
        'unsupported_specificity',
        'fabricated_reference',
        'temporal_impossibility',
        'inconsistency',
        'numeric_anomaly',
      ],
      thresholds: {
        pass: 'riskScore < 0.3',
        flag_for_review: '0.3 <= riskScore < 0.6',
        reject: 'riskScore >= 0.6',
      },
    });
  });

  router.post('/api/quality/check', (req, res) => {
    const { input, output } = req.body ?? {};
    if (!output) {
      return res.status(400).json({ error: 'output is required' });
    }

    const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '');
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

    const hallucinationReport = hallucinationDetector.analyze(inputStr, outputStr);

    let consensusScore = 1.0;
    const consensusSignals: string[] = [];

    const hasHedging = /\b(might|may|could|likely|possibly|approximately|around|I think|it seems)\b/i.test(outputStr);
    if (hasHedging) consensusSignals.push('hedging_language');

    const contradictions = (outputStr.match(/\bhowever\b|\bbut\b|\bon the other hand\b|\bcontrary to\b/gi) ?? []).length;
    if (contradictions > 3) { consensusScore -= 0.2; consensusSignals.push(`contradiction_markers:${contradictions}`); }

    const sentences = outputStr.split(/[.!?]+/).filter((s: string) => s.trim().length > 20);
    const unique = new Set(sentences.map((s: string) => s.trim().toLowerCase()));
    const repRate = 1 - (unique.size / Math.max(sentences.length, 1));
    if (repRate > 0.3) { consensusScore -= 0.25; consensusSignals.push(`repetition:${(repRate * 100).toFixed(0)}%`); }
    consensusScore = Math.max(0, Math.min(1, consensusScore));

    const handoffSignals: string[] = [];
    let handoffPassed = true;
    if (!input) { handoffPassed = false; handoffSignals.push('missing_input'); }

    const outputValid = output !== null && output !== undefined && outputStr.trim().length > 0;

    res.json({
      hallucination: hallucinationReport,
      consensus: {
        score: consensusScore,
        passed: consensusScore >= 0.67,
        signals: consensusSignals,
      },
      handoff: {
        passed: handoffPassed,
        signals: handoffSignals,
      },
      outputValidation: {
        passed: outputValid,
      },
      overall: {
        passed: hallucinationReport.recommendation !== 'reject' && consensusScore >= 0.67 && handoffPassed && outputValid,
      },
    });
  });

  router.post('/api/consistency/record', (req, res) => {
    const { missionId, agentId, outputType, content } = req.body ?? {};
    if (!agentId || !content) {
      return res.status(400).json({ error: 'agentId and content are required' });
    }
    const manager = getConsistencyMonitorManager();
    manager.recordOutput(missionId ?? 'global', {
      agentId,
      type: outputType ?? 'analysis',
      content,
      timestamp: Date.now(),
    });
    res.json({ status: 'recorded' });
  });

  router.get('/api/consistency/check/:missionId', (req, res) => {
    const manager = getConsistencyMonitorManager();
    const report = manager.checkConsistency(req.params.missionId);
    res.json(report);
  });

  router.get('/api/consistency/status', (_req, res) => {
    const manager = getConsistencyMonitorManager();
    const all = manager.getAllConsistencyStatus();
    const result: Record<string, any> = {};
    all.forEach((report, missionId) => {
      result[missionId] = report;
    });
    res.json(result);
  });

  return router;
}
