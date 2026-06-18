"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeSearchTool = void 0;
const child_process_1 = require("child_process");
const fileSystemTool_1 = require("./fileSystemTool");
const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', 'target'];
const DEFINITION = {
    name: 'code_search',
    description: 'Search code for patterns, symbols, or text like TODO/FIXME/HACK comments. Excludes node_modules, .git, dist, and build directories. Supports regex, file scoping, and symbol type filtering (functions, classes, interfaces).',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'The code or text pattern to search for (supports regex). Use for: TODO/FIXME/HACK comments, function names, variable names, error messages, or any code pattern.',
            },
            filePattern: {
                type: 'string',
                description: 'File glob pattern (e.g., "src/**/*.ts", "*.py"). Defaults to common code file types (*.ts, *.js, *.py, *.rs, *.go).',
            },
            symbolType: {
                type: 'string',
                enum: ['function', 'class', 'interface', 'variable', 'import', 'all'],
                description: 'Type of symbol to search for. Use "all" or leave empty for plain text/pattern search (e.g. TODO comments).',
            },
            maxResults: {
                type: 'number',
                description: 'Maximum number of results to return (default: 10)',
            },
            contextLines: {
                type: 'number',
                description: 'Lines of context around each match (default: 3)',
            },
            searchDomain: {
                type: 'string',
                enum: ['workspace', 'tests', 'docs', 'config'],
                description: 'Scope to narrow the search',
            },
        },
        required: ['pattern'],
    },
    examples: [
        { name: 'code_search', arguments: { pattern: 'TODO', filePattern: 'src/**/*.ts' } },
        { name: 'code_search', arguments: { pattern: 'class Repository', symbolType: 'class' } },
    ],
    category: 'development',
};
class CodeSearchTool {
    constructor() {
        this.definition = DEFINITION;
        this.isConcurrencySafe = true;
        this.isReadOnly = true;
        this.timeout = 30000;
        this.maxOutputSize = 50000;
    }
    async execute(args) {
        var _a, _b, _c, _d, _e, _f;
        const pattern = String((_a = args.pattern) !== null && _a !== void 0 ? _a : '');
        const filePattern = String((_b = args.filePattern) !== null && _b !== void 0 ? _b : '');
        const symbolType = String((_c = args.symbolType) !== null && _c !== void 0 ? _c : 'all');
        const maxResults = Number((_d = args.maxResults) !== null && _d !== void 0 ? _d : 10);
        const contextLines = Number((_e = args.contextLines) !== null && _e !== void 0 ? _e : 3);
        const searchDomain = String((_f = args.searchDomain) !== null && _f !== void 0 ? _f : 'workspace');
        if (!pattern)
            return 'Error: No search pattern provided.';
        if (pattern.length < 2)
            return 'Error: Search pattern too short (min 2 chars).';
        const cwd = (0, fileSystemTool_1.getSafeRoot)();
        let searchDir = cwd;
        if (searchDomain === 'tests')
            searchDir = `${cwd}/tests`;
        else if (searchDomain === 'docs')
            searchDir = `${cwd}/docs`;
        else if (searchDomain === 'config')
            searchDir = `${cwd}/config`;
        try {
            let grepPattern = pattern;
            if (symbolType === 'function')
                grepPattern = `(def |function |async function|fn )${pattern}`;
            else if (symbolType === 'class')
                grepPattern = `(class |interface )${pattern}`;
            else if (symbolType === 'import')
                grepPattern = `(import |from |require\\().*${pattern}`;
            const maxHead = maxResults * (contextLines * 2 + 2);
            // SECURITY FIX: use execFileSync with argv array instead of execSync with shell string
            // This prevents command injection via pattern/filePattern containing shell metacharacters
            const args = [
                '-rn',
                '-B',
                String(contextLines),
                '-A',
                String(contextLines),
                ...EXCLUDE_DIRS.flatMap((d) => ['--exclude-dir', d]),
            ];
            if (filePattern) {
                // filePattern is user-supplied but passed as a grep arg, not interpolated into shell
                args.push('-E', grepPattern, filePattern);
            }
            else {
                args.push('--include=*.ts', '--include=*.js', '--include=*.py', '--include=*.rs', '--include=*.go', '-E', grepPattern, searchDir);
            }
            let stdout;
            try {
                stdout = (0, child_process_1.execFileSync)('grep', args, {
                    cwd: searchDir,
                    timeout: 15000,
                    maxBuffer: 10 * 1024 * 1024,
                    encoding: 'utf-8',
                });
            }
            catch (grepErr) {
                // grep exits 1 when no matches (not an error), 2 for actual errors
                const err = grepErr;
                if (err.status === 1) {
                    // No matches found — return clean message regardless of stdout presence
                    return `No results found for pattern: ${pattern}`;
                }
                throw grepErr;
            }
            const lines = stdout.trim().split('\n').filter(Boolean);
            if (lines.length === 0)
                return `No results found for pattern: ${pattern}`;
            const matchCount = lines.filter((l) => l.includes(grepPattern) || l.includes(pattern)).length;
            const sliced = lines.slice(0, maxHead).join('\n');
            return `Found ${matchCount} matches in ${lines.length} lines:\n\n${sliced}`;
        }
        catch (searchErr) {
            const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
            if (msg.includes('no results') || msg.toLowerCase().includes('no such file')) {
                return `No results found for pattern: ${pattern}`;
            }
            return `Search failed: ${msg.slice(0, 200)}`;
        }
    }
}
exports.CodeSearchTool = CodeSearchTool;
