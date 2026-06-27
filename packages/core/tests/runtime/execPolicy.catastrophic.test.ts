import { describe, it, expect, beforeEach } from 'vitest';
import { ExecPolicyEngine } from '../../src/sandbox/execPolicy';

describe('ExecPolicyEngine — forbid-catastrophic rules', () => {
  let engine: ExecPolicyEngine;

  beforeEach(() => {
    engine = new ExecPolicyEngine();
  });

  describe('catastrophic commands (forbidden — cannot be approved)', () => {
    it('should forbid bare rm -rf /', () => {
      const result = engine.evaluate('rm -rf /');
      expect(result.decision).toBe('forbidden');
      expect(result.rule?.id).toBe('forbid-catastrophic');
    });

    it('should forbid rm -rf ~', () => {
      const result = engine.evaluate('rm -rf ~');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid rm -rf *', () => {
      const result = engine.evaluate('rm -rf *');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid rm -rf .', () => {
      const result = engine.evaluate('rm -rf .');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid rm -rf $HOME', () => {
      const result = engine.evaluate('rm -rf $HOME');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid rm -rf $PWD', () => {
      const result = engine.evaluate('rm -rf $PWD');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid rm -fr / (reversed flags)', () => {
      const result = engine.evaluate('rm -fr /');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid rm -r / (without -f)', () => {
      const result = engine.evaluate('rm -r /');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid chmod -R 777 /', () => {
      const result = engine.evaluate('chmod -R 777 /');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid chmod -R 777 ~', () => {
      const result = engine.evaluate('chmod -R 777 ~');
      expect(result.decision).toBe('forbidden');
    });
  });

  describe('destructive commands (prompt — requires approval)', () => {
    it('should prompt for rm -rf /tmp/specific-dir', () => {
      const result = engine.evaluate('rm -rf /tmp/specific-dir');
      expect(result.decision).toBe('prompt');
    });

    it('should prompt for git reset --hard', () => {
      const result = engine.evaluate('git reset --hard');
      expect(result.decision).toBe('prompt');
    });

    it('should prompt for git clean -f', () => {
      const result = engine.evaluate('git clean -f');
      expect(result.decision).toBe('prompt');
    });
  });

  describe('safe commands (allowed)', () => {
    it('should allow ls', () => {
      const result = engine.evaluate('ls -la');
      expect(result.decision).toBe('allow');
    });

    it('should allow cat', () => {
      const result = engine.evaluate('cat /tmp/test.txt');
      expect(result.decision).toBe('allow');
    });

    it('should allow grep', () => {
      const result = engine.evaluate('grep -r "pattern" /tmp');
      expect(result.decision).toBe('allow');
    });
  });

  describe('forbidden commands (always blocked)', () => {
    it('should forbid sudo', () => {
      const result = engine.evaluate('sudo rm -rf /');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid mkfs', () => {
      const result = engine.evaluate('mkfs.ext4 /dev/sda1');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid dd to device', () => {
      const result = engine.evaluate('dd if=/dev/zero of=/dev/sda');
      expect(result.decision).toBe('forbidden');
    });
  });

  describe('command chaining', () => {
    it('should forbid rm -rf / in chained command', () => {
      const result = engine.evaluate('rm -rf /; echo done');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid rm -rf / in piped command', () => {
      const result = engine.evaluate('echo test | rm -rf /');
      expect(result.decision).toBe('forbidden');
    });

    it('should forbid rm -rf / in AND chain', () => {
      const result = engine.evaluate('rm -rf / && echo done');
      expect(result.decision).toBe('forbidden');
    });
  });
});
