import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { UserModelManager } from '../../src/memory/userModel';

describe('UserModelManager', () => {
  let manager: UserModelManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usermodel-test-'));
    manager = new UserModelManager({ modelPath: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getProfile', () => {
    it('creates a default profile for new user', () => {
      const profile = manager.getProfile('user-1');
      assert.equal(profile.userId, 'user-1');
      assert.equal(profile.interactionCount, 0);
      assert.equal(profile.modelConfidence, 0);
      assert.ok(profile.createdAt);
    });

    it('returns same profile on subsequent calls', () => {
      const p1 = manager.getProfile('user-1');
      const p2 = manager.getProfile('user-1');
      assert.equal(p1, p2);
    });

    it('creates separate profiles for different users', () => {
      const p1 = manager.getProfile('user-1');
      const p2 = manager.getProfile('user-2');
      assert.notEqual(p1, p2);
      assert.equal(p1.userId, 'user-1');
      assert.equal(p2.userId, 'user-2');
    });

    it('default preferences are balanced/moderate', () => {
      const profile = manager.getProfile('user-1');
      assert.equal(profile.preferences.codingStyle, 'balanced');
      assert.equal(profile.preferences.explanationLevel, 'moderate');
      assert.equal(profile.preferences.language, 'en');
      assert.equal(profile.preferences.showDiffs, true);
      assert.equal(profile.preferences.askBeforeEditing, true);
    });
  });

  describe('recordInteraction', () => {
    it('increments interaction count', () => {
      manager.recordInteraction('user-1', { message: 'hello', role: 'user' });
      const profile = manager.getProfile('user-1');
      assert.equal(profile.interactionCount, 1);
    });

    it('updates model confidence with interactions', () => {
      for (let i = 0; i < 10; i++) {
        manager.recordInteraction('user-1', { message: 'test message', role: 'user' });
      }
      const profile = manager.getProfile('user-1');
      assert.ok(profile.modelConfidence > 0);
      assert.ok(profile.modelConfidence <= 1);
    });

    it('updates communication style from user messages', () => {
      // Formal, verbose message
      manager.recordInteraction('user-1', {
        message:
          'I would appreciate it if you could provide a comprehensive analysis of the authentication system, including a detailed examination of the security implications and potential vulnerabilities.',
        role: 'user',
      });
      const profile = manager.getProfile('user-1');
      assert.ok(profile.communicationStyle.verbosity > 0);
    });

    it('tracks tool usage', () => {
      manager.recordInteraction('user-1', { message: 'test', role: 'user', toolUsed: 'git' });
      manager.recordInteraction('user-1', { message: 'test', role: 'user', toolUsed: 'git' });
      const profile = manager.getProfile('user-1');
      assert.equal(profile.toolPatterns.mostUsedTools.get('git'), 2);
    });

    it('updates topic interests', () => {
      manager.recordInteraction('user-1', {
        message: 'How do I implement authentication with JWT tokens in TypeScript?',
        role: 'user',
      });
      const profile = manager.getProfile('user-1');
      // Should detect authentication and typescript topics
      const hasAuth = profile.topicInterests.has('authentication');
      const hasTS = profile.topicInterests.has('typescript');
      assert.ok(hasAuth || hasTS, 'Should detect at least one topic');
    });

    it('updates domain expertise', () => {
      manager.recordInteraction('user-1', {
        message: 'I need to refactor the dependency injection container',
        role: 'user',
        domain: 'architecture',
      });
      const profile = manager.getProfile('user-1');
      assert.ok(profile.expertise.has('architecture'));
    });

    it('does not update communication style for assistant messages', () => {
      manager.recordInteraction('user-1', { message: 'Here is the answer...', role: 'assistant' });
      const profile = manager.getProfile('user-1');
      // Style should remain at defaults
      assert.equal(profile.communicationStyle.formality, 0.5);
    });
  });

  describe('addObservation', () => {
    it('adds a new observation', () => {
      manager.addObservation('user-1', {
        category: 'preference',
        content: 'Prefers TypeScript over JavaScript',
        confidence: 0.7,
        evidenceCount: 1,
        tags: ['language'],
      });
      const profile = manager.getProfile('user-1');
      assert.equal(profile.observations.length, 1);
      assert.equal(profile.observations[0].content, 'Prefers TypeScript over JavaScript');
    });

    it('deduplicates observations by category+content', () => {
      manager.addObservation('user-1', {
        category: 'preference',
        content: 'Prefers TypeScript',
        confidence: 0.5,
        evidenceCount: 1,
        tags: [],
      });
      manager.addObservation('user-1', {
        category: 'preference',
        content: 'Prefers TypeScript',
        confidence: 0.6,
        evidenceCount: 2,
        tags: [],
      });
      const profile = manager.getProfile('user-1');
      assert.equal(profile.observations.length, 1);
      assert.equal(profile.observations[0].evidenceCount, 2);
      assert.ok(profile.observations[0].confidence > 0.5);
    });

    it('strengthens existing observations', () => {
      manager.addObservation('user-1', {
        category: 'behavior',
        content: 'Asks follow-up questions',
        confidence: 0.5,
        evidenceCount: 1,
        tags: [],
      });
      manager.addObservation('user-1', {
        category: 'behavior',
        content: 'Asks follow-up questions',
        confidence: 0.5,
        evidenceCount: 1,
        tags: [],
      });
      const profile = manager.getProfile('user-1');
      assert.equal(profile.observations[0].evidenceCount, 2);
      assert.ok(profile.observations[0].confidence > 0.5);
    });

    it('trims observations beyond maxObservations', () => {
      const mgr = new UserModelManager({ modelPath: tmpDir, maxObservations: 3 });
      for (let i = 0; i < 5; i++) {
        mgr.addObservation('user-1', {
          category: 'behavior',
          content: `Observation ${i}`,
          confidence: 0.5 + i * 0.1,
          evidenceCount: 1,
          tags: [],
        });
      }
      const profile = mgr.getProfile('user-1');
      assert.ok(profile.observations.length <= 3);
      // Should keep highest confidence ones
      const confidences = profile.observations.map((o) => o.confidence);
      assert.ok(confidences[0] >= confidences[1]);
    });
  });

  describe('setPreference', () => {
    it('sets a preference value', () => {
      manager.setPreference('user-1', 'codingStyle', 'minimal');
      const profile = manager.getProfile('user-1');
      assert.equal(profile.preferences.codingStyle, 'minimal');
    });

    it('sets custom preferences', () => {
      manager.setPreference('user-1', 'custom', new Map([['theme', 'dark']]));
      const profile = manager.getProfile('user-1');
      assert.equal(profile.preferences.custom.get('theme'), 'dark');
    });
  });

  describe('getContextSummary', () => {
    it('returns empty string for new users', () => {
      const summary = manager.getContextSummary('user-1');
      assert.equal(summary, '');
    });

    it('returns summary after enough interactions', () => {
      for (let i = 0; i < 5; i++) {
        manager.recordInteraction('user-1', { message: 'test message here', role: 'user' });
      }
      const summary = manager.getContextSummary('user-1');
      assert.ok(summary.length > 0);
      assert.ok(summary.includes('User Profile'));
    });

    it('includes preferences in summary', () => {
      manager.setPreference('user-1', 'codingStyle', 'minimal');
      for (let i = 0; i < 5; i++) {
        manager.recordInteraction('user-1', { message: 'test', role: 'user' });
      }
      const summary = manager.getContextSummary('user-1');
      assert.ok(summary.includes('minimal'));
    });
  });

  describe('saveProfile / loadProfile', () => {
    it('round-trips profile through disk', () => {
      manager.recordInteraction('user-1', {
        message: 'hello world test',
        role: 'user',
        toolUsed: 'git',
      });
      manager.addObservation('user-1', {
        category: 'preference',
        content: 'Likes TypeScript',
        confidence: 0.8,
        evidenceCount: 3,
        tags: ['lang'],
      });
      manager.saveProfile('user-1');

      // Create fresh manager to test loading
      const manager2 = new UserModelManager({ modelPath: tmpDir });
      const loaded = manager2.loadProfile('user-1');
      assert.ok(loaded);
      assert.equal(loaded!.userId, 'user-1');
      assert.equal(loaded!.interactionCount, 1);
    });

    it('returns null for non-existent profile', () => {
      const loaded = manager.loadProfile('nonexistent');
      assert.equal(loaded, null);
    });

    it('handles corrupted profile file gracefully', () => {
      const profilePath = path.join(tmpDir, 'user-bad.json');
      fs.writeFileSync(profilePath, 'not valid json');
      const mgr = new UserModelManager({ modelPath: tmpDir });
      const loaded = mgr.loadProfile('user-bad');
      assert.equal(loaded, null);
    });
  });
});
