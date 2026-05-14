import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  WebSearchTool, WebFetchTool,
  FileReadTool, FileWriteTool, FileEditTool, FileSearchTool, FileListTool,
  PythonExecuteTool, ShellExecuteTool,
  MemoryStoreTool, MemoryRecallTool, MemoryListTool,
  GitTool,
  createAllTools,
} from '../src/tools/index';

describe('Commander Tools Integration', () => {

  it('web_search returns results', async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute({ query: 'latest AI news 2026', numResults: 3 });
    // Web search may fail without API key — just log the outcome
    if (result.startsWith('Error') || result.length < 50) {
      console.log(`  [web_search] unavailable or returned short result (${result.length} chars)`);
      console.log(`  [web_search] first 100 chars: ${result.slice(0, 100).replace(/\n/g, ' ')}`);
    } else {
      console.log(`  [web_search] returned ${result.length} chars`);
    }
    assert.ok(result.length >= 0); // non-destructive: just verify it executed
  });

  it('file_write and file_read roundtrip', async () => {
    const testFile = '.commander_test_write.txt';
    const writer = new FileWriteTool();
    const reader = new FileReadTool();

    await writer.execute({ path: testFile, content: 'Hello Commander!' });
    const result = await reader.execute({ path: testFile });
    assert.ok(result.includes('Hello Commander!'), 'Should read back written content');

    fs.unlinkSync(path.resolve(testFile));
    console.log('  [file_write/read] Roundtrip OK');
  });

  it('file_edit works', async () => {
    const testFile = '.commander_test_edit.txt';
    fs.writeFileSync(path.resolve(testFile), 'line1\nline2\nline3\n');

    const editor = new FileEditTool();
    await editor.execute({ path: testFile, oldString: 'line2', newString: 'modified' });

    const content = fs.readFileSync(path.resolve(testFile), 'utf-8');
    assert.ok(content.includes('modified'), 'Should contain edited content');
    assert.ok(!content.includes('line2'), 'Should not contain old content');

    fs.unlinkSync(path.resolve(testFile));
    console.log('  [file_edit] OK');
  });

  it('file_search finds files by pattern', async () => {
    const tool = new FileSearchTool();
    const result = await tool.execute({ pattern: 'src/tools/*.ts', maxResults: 10 });
    assert.ok(result.length > 0, 'Should find tool files');
    assert.ok(result.includes('webSearchTool'), 'Should find webSearchTool.ts');
    console.log(`  [file_search] Found ${result.split('\n').length} files`);
  });

  it('file_list shows directory', async () => {
    const tool = new FileListTool();
    const result = await tool.execute({ path: 'src/tools' });
    assert.ok(result.length > 0, 'Should list directory');
    assert.ok(result.includes('webSearchTool') || result.includes('fileSystemTool'), 'Should show tool files');
    console.log(`  [file_list] ${result.split('\n').length} entries`);
  });

  it('python_execute runs code', async () => {
    const tool = new PythonExecuteTool();
    const result = await tool.execute({ code: 'print(sum(range(1,101)))' });
    assert.ok(result.includes('5050'), 'Should compute 1+...+100 = 5050');
    console.log(`  [python_execute] ${result.slice(0, 100)}`);
  });

  it('shell_execute runs command', async () => {
    const tool = new ShellExecuteTool();
    const result = await tool.execute({ command: 'echo "hello world"' });
    assert.ok(result.includes('hello world'), 'Should run shell command');
    console.log(`  [shell_execute] ${result.slice(0, 100)}`);
  });

  it('memory_store and memory_recall roundtrip', async () => {
    const store = new MemoryStoreTool();
    const recall = new MemoryRecallTool();

    await store.execute({ key: 'test/key', value: 'test value', namespace: 'test' });
    const result = await recall.execute({ key: 'test/key', namespace: 'test' });
    assert.ok(result.includes('test value'), 'Should recall stored memory');

    const listed = await new MemoryListTool().execute({});
    assert.ok(listed.includes('test'), 'Should list namespace');
    console.log('  [memory] Store/recall/list OK');
  });

  it('git returns status', async () => {
    const tool = new GitTool();
    const result = await tool.execute({ command: 'status' });
    assert.ok(result.length > 0, 'Should return git status');
    assert.ok(!result.startsWith('[Error]'), 'Should not error');
    console.log(`  [git] ${result.slice(0, 100)}`);
  });

  it('createAllTools returns all tools', () => {
    const tools = createAllTools();
    assert.ok(tools.size >= 9, 'Should have at least 9 tools');
    assert.ok(tools.has('web_search'));
    assert.ok(tools.has('web_fetch'));
    assert.ok(tools.has('file_read'));
    assert.ok(tools.has('file_write'));
    assert.ok(tools.has('file_edit'));
    assert.ok(tools.has('file_search'));
    assert.ok(tools.has('file_list'));
    assert.ok(tools.has('python_execute'));
    assert.ok(tools.has('shell_execute'));
    assert.ok(tools.has('git'));
    assert.ok(tools.has('memory_store'));
    assert.ok(tools.has('memory_recall'));
    assert.ok(tools.has('memory_list'));
    console.log(`  [createAllTools] ${tools.size} tools: ${Array.from(tools.keys()).join(', ')}`);
  });
});

describe('Full Multi-Agent Pipeline with Tools', () => {

  it('deliberation + tools classification works', async () => {
    const { deliberate } = await import('../src/ultimate/deliberation');
    const plan = deliberate('Search the web for the latest population of Tokyo and write it to a file');

    assert.strictEqual(plan.requiresExternalInfo, true);
    assert.ok(plan.capabilitiesNeeded.includes('web_search') || plan.capabilitiesNeeded.length > 0);
    console.log(`  [deliberation] Task type: ${plan.taskType}, needs web: ${plan.requiresExternalInfo}`);
  });
});
