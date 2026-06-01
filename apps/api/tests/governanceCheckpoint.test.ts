import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CheckpointManager,
  RiskScoreCalculator,
  DEFAULT_CHECKPOINT_CONFIGS,
} from '../src/governanceCheckpoint';

describe('CheckpointManager', () => {
  let manager: CheckpointManager;

  beforeEach(() => {
    manager = new CheckpointManager();
  });

  describe('determineCheckpointType', () => {
    it('returns mandatory for MANUAL mode', () => {
      assert.equal(manager.determineCheckpointType('MANUAL', 0), 'mandatory');
      assert.equal(manager.determineCheckpointType('MANUAL', 100), 'mandatory');
    });

    it('returns automatic for AUTO mode', () => {
      assert.equal(manager.determineCheckpointType('AUTO', 0), 'automatic');
      assert.equal(manager.determineCheckpointType('AUTO', 100), 'automatic');
    });

    it('returns conditional for GUARDED mode above threshold', () => {
      assert.equal(manager.determineCheckpointType('GUARDED', 60), 'conditional');
      assert.equal(manager.determineCheckpointType('GUARDED', 50), 'conditional');
    });

    it('returns automatic for GUARDED mode below threshold', () => {
      assert.equal(manager.determineCheckpointType('GUARDED', 49), 'automatic');
      assert.equal(manager.determineCheckpointType('GUARDED', 0), 'automatic');
    });

    it('respects custom risk threshold', () => {
      assert.equal(manager.determineCheckpointType('GUARDED', 30, 30), 'conditional');
      assert.equal(manager.determineCheckpointType('GUARDED', 29, 30), 'automatic');
    });
  });

  describe('create', () => {
    it('creates an automatic checkpoint for AUTO mode', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test task',
        'AUTO', 0, 'LOW', [], [],
      );
      assert.equal(ckpt.type, 'automatic');
      assert.equal(ckpt.status, 'approved');
      assert.deepEqual(ckpt.requiredApprovals, []);
    });

    it('creates a mandatory checkpoint for MANUAL mode', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'deploy task',
        'MANUAL', 80, 'CRITICAL', [], ['approver-1'],
      );
      assert.equal(ckpt.type, 'mandatory');
      assert.equal(ckpt.status, 'pending');
      assert.deepEqual(ckpt.requiredApprovals, ['approver-1']);
    });

    it('stores risk factors in context', () => {
      const factors = [{ category: 'security' as const, description: 'test', severity: 'high' as const }];
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'AUTO', 0, 'LOW', factors, [],
      );
      assert.deepEqual(ckpt.context.riskFactors, factors);
    });

    it('checkpoint is retrievable by ID', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'AUTO', 0, 'LOW', [], [],
      );
      assert.equal(manager.get(ckpt.id), ckpt);
    });
  });

  describe('approve', () => {
    it('approves a pending checkpoint', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'MANUAL', 80, 'HIGH', [], ['approver-1'],
      );
      manager.approve(ckpt.id, 'approver-1', 'Looks good');
      const updated = manager.get(ckpt.id)!;
      assert.equal(updated.status, 'approved');
      assert.equal(updated.currentApprovals.length, 1);
    });

    it('throws for non-existent checkpoint', () => {
      assert.throws(() => manager.approve('nonexistent', 'user'), /not found/);
    });

    it('throws for non-pending checkpoint', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'AUTO', 0, 'LOW', [], [],
      );
      assert.throws(() => manager.approve(ckpt.id, 'user'), /not pending/);
    });

    it('throws for unauthorized reviewer', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'MANUAL', 80, 'HIGH', [], ['approver-1'],
      );
      assert.throws(() => manager.approve(ckpt.id, 'unauthorized'), /not authorized/);
    });

    it('throws for duplicate approval when checkpoint still pending', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'MANUAL', 80, 'HIGH', [], ['approver-1', 'approver-2'],
      );
      manager.approve(ckpt.id, 'approver-1');
      assert.throws(() => manager.approve(ckpt.id, 'approver-1'), /Already approved/);
    });

    it('requires all approvers for multi-approver checkpoint', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'MANUAL', 80, 'HIGH', [], ['approver-1', 'approver-2'],
      );
      manager.approve(ckpt.id, 'approver-1');
      const partial = manager.get(ckpt.id)!;
      assert.equal(partial.status, 'pending');

      manager.approve(ckpt.id, 'approver-2');
      const full = manager.get(ckpt.id)!;
      assert.equal(full.status, 'approved');
    });
  });

  describe('reject', () => {
    it('rejects a pending checkpoint', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'MANUAL', 80, 'HIGH', [], ['approver-1'],
      );
      manager.reject(ckpt.id, 'approver-1', 'Too risky');
      const updated = manager.get(ckpt.id)!;
      assert.equal(updated.status, 'rejected');
    });

    it('throws for non-pending checkpoint', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'AUTO', 0, 'LOW', [], [],
      );
      assert.throws(() => manager.reject(ckpt.id, 'user', 'reason'), /not pending/);
    });
  });

  describe('getPendingByMission', () => {
    it('returns only pending checkpoints for a mission', () => {
      manager.create('mission-1', 'task-1', 'agent-1', 'executor', 'test', 'MANUAL', 80, 'HIGH', [], ['a1']);
      manager.create('mission-1', 'task-2', 'agent-1', 'executor', 'test', 'AUTO', 0, 'LOW', [], []);
      const pending = manager.getPendingByMission('mission-1');
      assert.equal(pending.length, 1);
      assert.equal(pending[0].taskId, 'task-1');
    });
  });

  describe('getPendingForApprover', () => {
    it('returns checkpoints pending for a specific approver', () => {
      manager.create('mission-1', 'task-1', 'agent-1', 'executor', 'test', 'MANUAL', 80, 'HIGH', [], ['a1', 'a2']);
      const pending = manager.getPendingForApprover('a1');
      assert.equal(pending.length, 1);
    });

    it('excludes already-approved checkpoints', () => {
      const ckpt = manager.create('mission-1', 'task-1', 'agent-1', 'executor', 'test', 'MANUAL', 80, 'HIGH', [], ['a1']);
      manager.approve(ckpt.id, 'a1');
      assert.equal(manager.getPendingForApprover('a1').length, 0);
    });
  });

  describe('checkExpirations', () => {
    it('marks expired checkpoints', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'MANUAL', 80, 'HIGH', [], ['a1'], 1, // 1ms timeout
      );
      // Wait for expiration
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }
      const expired = manager.checkExpirations();
      assert.ok(expired.length >= 1);
    });

    it('applies proceed fallback for expired checkpoints', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'GUARDED', 60, 'HIGH', [], ['a1'], 1,
      );
      // Override fallback to proceed
      const c = manager.get(ckpt.id)!;
      (c as any).fallbackAction = 'proceed';
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }
      manager.checkExpirations();
      const updated = manager.get(ckpt.id)!;
      assert.equal(updated.status, 'approved');
    });
  });

  describe('addEvidence', () => {
    it('adds evidence to a checkpoint', () => {
      const ckpt = manager.create(
        'mission-1', 'task-1', 'agent-1', 'executor', 'test',
        'AUTO', 0, 'LOW', [], [],
      );
      manager.addEvidence(ckpt.id, {
        type: 'log',
        timestamp: new Date().toISOString(),
        content: 'test evidence',
        source: 'test',
      });
      const updated = manager.get(ckpt.id)!;
      assert.ok(updated.context.evidence.some(e => e.content === 'test evidence'));
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      manager.create('m1', 't1', 'a1', 'executor', 'test', 'AUTO', 0, 'LOW', [], []);
      manager.create('m1', 't2', 'a1', 'executor', 'test', 'MANUAL', 80, 'HIGH', [], ['a1']);
      const stats = manager.getStats();
      assert.equal(stats.total, 2);
      assert.equal(stats.approved, 1);
      assert.equal(stats.pending, 1);
      assert.equal(stats.automaticCount, 1);
      assert.equal(stats.mandatoryCount, 1);
    });
  });
});

describe('RiskScoreCalculator', () => {
  describe('calculate', () => {
    it('returns base score for LOW risk', () => {
      const score = RiskScoreCalculator.calculate('AUTO', 'LOW', [], 'public');
      assert.equal(score, 20);
    });

    it('adds governance mode adjustment', () => {
      const autoScore = RiskScoreCalculator.calculate('AUTO', 'LOW', [], 'public');
      const manualScore = RiskScoreCalculator.calculate('MANUAL', 'LOW', [], 'public');
      assert.equal(manualScore - autoScore, 10);
    });

    it('adds risk for high-risk operations', () => {
      const normal = RiskScoreCalculator.calculate('AUTO', 'LOW', ['read'], 'public');
      const risky = RiskScoreCalculator.calculate('AUTO', 'LOW', ['delete-user'], 'public');
      assert.equal(risky - normal, 15);
    });

    it('adds data sensitivity adjustment', () => {
      const publicScore = RiskScoreCalculator.calculate('AUTO', 'LOW', [], 'public');
      const restrictedScore = RiskScoreCalculator.calculate('AUTO', 'LOW', [], 'restricted');
      assert.equal(restrictedScore - publicScore, 25);
    });

    it('caps at 100', () => {
      const score = RiskScoreCalculator.calculate('MANUAL', 'CRITICAL', ['deploy production'], 'restricted');
      assert.equal(score, 100);
    });
  });

  describe('scoreToLevel', () => {
    it('maps scores to risk levels', () => {
      assert.equal(RiskScoreCalculator.scoreToLevel(0), 'LOW');
      assert.equal(RiskScoreCalculator.scoreToLevel(29), 'LOW');
      assert.equal(RiskScoreCalculator.scoreToLevel(30), 'MEDIUM');
      assert.equal(RiskScoreCalculator.scoreToLevel(59), 'MEDIUM');
      assert.equal(RiskScoreCalculator.scoreToLevel(60), 'HIGH');
      assert.equal(RiskScoreCalculator.scoreToLevel(79), 'HIGH');
      assert.equal(RiskScoreCalculator.scoreToLevel(80), 'CRITICAL');
      assert.equal(RiskScoreCalculator.scoreToLevel(100), 'CRITICAL');
    });
  });
});

describe('DEFAULT_CHECKPOINT_CONFIGS', () => {
  it('has configs for all governance modes', () => {
    assert.ok(DEFAULT_CHECKPOINT_CONFIGS.AUTO);
    assert.ok(DEFAULT_CHECKPOINT_CONFIGS.GUARDED);
    assert.ok(DEFAULT_CHECKPOINT_CONFIGS.MANUAL);
  });

  it('AUTO has no timeout', () => {
    assert.equal(DEFAULT_CHECKPOINT_CONFIGS.AUTO.timeout, undefined);
  });

  it('GUARDED has 5-minute timeout', () => {
    assert.equal(DEFAULT_CHECKPOINT_CONFIGS.GUARDED.timeout, 300000);
  });

  it('MANUAL has 1-hour timeout', () => {
    assert.equal(DEFAULT_CHECKPOINT_CONFIGS.MANUAL.timeout, 3600000);
  });
});
