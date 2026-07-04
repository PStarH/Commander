import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactSystem } from '../../src/ultimate/artifactSystem';

describe('ArtifactSystem', () => {
  let system: ArtifactSystem;

  beforeEach(() => {
    system = new ArtifactSystem();
  });

  describe('search', () => {
    it('treats user query as literal text, not regex', async () => {
      await system.write('agent-1', 'text', 'Budget report 2024', 'Summary', 'The budget is $1,000.');
      await system.write('agent-1', 'text', 'Wildcard notes', 'Summary', 'Notes about test.* regex');

      // If the query were interpreted as regex, "test.*" would match both "test" and "test regex".
      const results = await system.search('test.*');
      const titles = results.map((r) => r.artifact.title);

      expect(titles).toContain('Wildcard notes');
      expect(titles).not.toContain('Budget report 2024');
    });

    it('escapes regex metacharacters in query terms', async () => {
      await system.write('agent-1', 'text', 'Brackets', 'Summary', 'Content with [brackets]');
      await system.write('agent-1', 'text', 'No brackets', 'Summary', 'Plain content');

      const results = await system.search('[brackets]');
      const titles = results.map((r) => r.artifact.title);

      expect(titles).toContain('Brackets');
      expect(titles).not.toContain('No brackets');
    });

    it('matches terms case-insensitively', async () => {
      await system.write('agent-1', 'text', 'Case Test', 'Summary', 'UPPER lower');

      const results = await system.search('upper');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].artifact.title).toBe('Case Test');
    });
  });
});
