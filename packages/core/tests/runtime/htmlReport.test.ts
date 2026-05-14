import { describe, it, expect } from 'vitest';
import { HTMLReportRenderer, createWarRoomHTMLReport } from '../../src/reporting/htmlReportRenderer';
import type { HTMLReport } from '../../src/runtime/types';

describe('HTMLReportRenderer', () => {
  const renderer = new HTMLReportRenderer();

  describe('basic rendering', () => {
    it('generates valid HTML from a report object', () => {
      const report: HTMLReport = {
        title: 'Test Report',
        subtitle: 'Unit Test',
        metadata: { type: 'TEST' },
        sections: [
          {
            title: 'Section 1',
            content: '<p>Hello world</p>',
            collapsible: false,
            priority: 0,
          },
        ],
        generatedAt: new Date().toISOString(),
        highlights: ['Test highlight'],
      };
      const html = renderer.render(report);
      expect(html).toContain('Test Report');
      expect(html).toContain('Hello world');
      expect(html).toContain('Test highlight');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('</html>');
    });

    it('handles empty highlights', () => {
      const report: HTMLReport = {
        title: 'No Highlights',
        metadata: {},
        sections: [],
        generatedAt: new Date().toISOString(),
        highlights: [],
      };
      const html = renderer.render(report);
      expect(html).toContain('No Highlights');
      expect(html).not.toContain('Key Highlights');
    });

    it('handles collapsible sections', () => {
      const report: HTMLReport = {
        title: 'Collapsible Test',
        metadata: {},
        sections: [
          {
            title: 'Hidden Section',
            content: 'secret content',
            collapsible: true,
            priority: 0,
          },
        ],
        generatedAt: new Date().toISOString(),
        highlights: [],
      };
      const html = renderer.render(report);
      expect(html).toContain('secret content');
      expect(html).toContain('click to toggle');
    });
  });

  describe('renderMetrics', () => {
    it('renders key-value pairs as metric cards', () => {
      const html = renderer.renderMetrics({ 'Tasks': 10, 'Agents': 3 });
      expect(html).toContain('Tasks');
      expect(html).toContain('10');
      expect(html).toContain('Agents');
      expect(html).toContain('3');
      expect(html).toContain('metric-card');
    });
  });

  describe('renderTable', () => {
    it('renders a table with headers and rows', () => {
      const html = renderer.renderTable(
        ['Name', 'Score'],
        [['Alice', '95'], ['Bob', '87']],
      );
      expect(html).toContain('Name');
      expect(html).toContain('Score');
      expect(html).toContain('Alice');
      expect(html).toContain('95');
      expect(html).toContain('Bob');
      expect(html).toContain('87');
      expect(html).toContain('<table>');
      expect(html).toContain('</table>');
    });
  });

  describe('renderStatusBadge', () => {
    it('renders success badges', () => {
      const html = renderer.renderStatusBadge('Completed', 'success');
      expect(html).toContain('Completed');
      expect(html).toContain('status-success');
    });

    it('renders failed badges', () => {
      const html = renderer.renderStatusBadge('Failed', 'failed');
      expect(html).toContain('status-failed');
    });
  });

  describe('renderTag', () => {
    it('renders tags with different variants', () => {
      const green = renderer.renderTag('active', 'green');
      expect(green).toContain('tag-green');
      const red = renderer.renderTag('blocked', 'red');
      expect(red).toContain('tag-red');
    });
  });
});

describe('createWarRoomHTMLReport', () => {
  it('creates a complete war room report', () => {
    const report = createWarRoomHTMLReport({
      projectName: 'War Room',
      operationCodename: 'Op Test',
      health: 'GREEN',
      metrics: { 'Agents': '5/5', 'Tasks': '12/15' },
      narrative: 'Good progress this week.',
      topAgents: [{ name: 'Builder', completed: 5 }],
      missionSummary: { 'Running': 3, 'Done': 12 },
    });

    expect(report.title).toContain('Op Test');
    expect(report.sections.length).toBeGreaterThanOrEqual(3);
    expect(report.highlights.length).toBeGreaterThan(0);
    expect(report.metadata.health).toBe('GREEN');
  });

  it('includes recent events when provided', () => {
    const report = createWarRoomHTMLReport({
      projectName: 'Test',
      operationCodename: 'Op',
      health: 'AMBER',
      metrics: {},
      narrative: 'Test narrative.',
      topAgents: [],
      missionSummary: {},
      recentEvents: [
        { timestamp: '2024-01-01', level: 'INFO', message: 'Started task' },
      ],
    });

    const eventSection = report.sections.find(s => s.title === 'Recent Execution Events');
    expect(eventSection).toBeDefined();
    expect(eventSection!.content).toContain('Started task');
  });
});
