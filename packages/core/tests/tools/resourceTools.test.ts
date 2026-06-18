import { describe, it, expect } from 'vitest';
import {
  createAllTools,
  FileResourceTool,
  WebResourceTool,
  ExecResourceTool,
  MediaResourceTool,
  SystemResourceTool,
  CheckpointResourceTool,
} from '../../src/tools/index';

describe('STRAP resource tools', () => {
  it('createAllTools exposes only consolidated resource tools and singletons', () => {
    const tools = createAllTools();
    const names = [...tools.keys()].sort();

    // Resource tools
    expect(names).toContain('file');
    expect(names).toContain('memory');
    expect(names).toContain('web');
    expect(names).toContain('browser');
    expect(names).toContain('code');
    expect(names).toContain('checkpoint');
    expect(names).toContain('handoff');
    expect(names).toContain('exec');
    expect(names).toContain('media');
    expect(names).toContain('system');

    // Singleton tools
    expect(names).toContain('git');
    expect(names).toContain('verify');
    expect(names).toContain('apply_patch');
    expect(names).toContain('verify_answer');
    expect(names).toContain('skill_view');
    expect(names).toContain('search_conversations');

    // Legacy granular CRUD names should NOT be exposed
    const legacy = [
      'file_read',
      'file_write',
      'file_edit',
      'file_search',
      'file_list',
      'glob',
      'web_search',
      'web_fetch',
      'browser_search',
      'browser_fetch',
      'memory_store',
      'memory_recall',
      'memory_list',
      'code_search',
      'refine_code',
      'fix_code',
      'python_execute',
      'shell_execute',
      'execute_script',
      'vision_analyze',
      'screenshot_capture',
      'pdf_extract',
      'checkpoint_save',
      'checkpoint_rewind',
      'checkpoint_list',
      'checkpoint_collapse',
      'handoff_check',
      'request_human_input',
      'request_tool',
    ];
    for (const name of legacy) {
      expect(names).not.toContain(name);
    }
  });

  it('file resource tool has action discriminator and required action param', () => {
    const tool = new FileResourceTool();
    expect(tool.definition.name).toBe('file');
    const schema = tool.definition.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toContain('action');
    expect(schema.properties.action).toEqual(
      expect.objectContaining({
        type: 'string',
        enum: expect.arrayContaining(['read', 'write', 'edit', 'search', 'list', 'glob']),
      }),
    );
  });

  it('exec resource tool has python, shell, and script actions', () => {
    const tool = new ExecResourceTool();
    const schema = tool.definition.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toContain('action');
    expect((schema.properties.action as { enum: string[] }).enum).toEqual(
      expect.arrayContaining(['python', 'shell', 'script']),
    );
  });

  it('media resource tool has analyze_image, screenshot, extract_pdf actions', () => {
    const tool = new MediaResourceTool();
    const schema = tool.definition.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect((schema.properties.action as { enum: string[] }).enum).toEqual(
      expect.arrayContaining(['analyze_image', 'screenshot', 'extract_pdf']),
    );
  });

  it('system resource tool has human_input and tool_schema actions', () => {
    const tool = new SystemResourceTool();
    const schema = tool.definition.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect((schema.properties.action as { enum: string[] }).enum).toEqual(
      expect.arrayContaining(['human_input', 'tool_schema']),
    );
  });

  it('resource tool execute returns error for unknown action', async () => {
    const tool = new WebResourceTool();
    const result = await tool.execute({ action: 'nonexistent' });
    expect(result).toContain('Unknown action');
  });

  it('checkpoint resource tool delegates save action', async () => {
    const tool = new CheckpointResourceTool();
    const result = await tool.execute({ action: 'list' });
    expect(result).toContain('No checkpoints saved');
  });
});
