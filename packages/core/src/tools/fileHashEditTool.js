"use strict";
/**
 * FileHashEditTool — Content-hash-anchored file editing.
 *
 * Uses the @hash→content format from HashAnchoredEditor for drift-proof
 * surgical edits. Unlike file_edit (which uses line numbers), this tool
 * anchors edits to per-line content hashes that survive line number drift.
 *
 * Format:
 *   ¶src/file.ts#FILE_HASH
 *   @A1B2C3→replacement text
 *   @D4E5F6,G7H8I9→
 *   multi-line
 *   replacement
 *
 * Per-line content hashes are shown in file_read output when
 * includeHashes:true is set. Each line gets a #XXXXXX hash annotation.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileHashEditTool = void 0;
const fs = __importStar(require("fs"));
const hashline_1 = require("../edit/hashline");
const hashAnchoredEditor_1 = require("../edit/hashAnchoredEditor");
const fileSystemTool_1 = require("./fileSystemTool");
const atomicWrite_1 = require("./_utils/atomicWrite");
const snapshotStore_1 = require("../edit/snapshotStore");
class FileHashEditTool {
    constructor() {
        this.definition = {
            name: 'file_hash_edit',
            description: `Edit a file using content-hash-anchored format (drift-proof).

PREFERRED over file_edit for all edits. Saves 61% tokens vs retyping old content.

FORMAT:
  ¶path/file.ts#FILE_HASH
  @CONTENT_HASH→replacement

HOW TO USE:
  1. Read the file with file_read(includeHashes:true)
  2. Each line shows its content hash as #XXXXXX at the end
  3. Create edits referencing those hashes: @XXXXXX→new content
  4. Multi-line: @HASH1,HASH2→ (then new lines on subsequent rows)

The file-level hash (#FILE_HASH) prevents editing stale files.
Content hashes stay valid even when line numbers change.`,
            inputSchema: {
                type: 'object',
                properties: {
                    input: {
                        type: 'string',
                        description: 'Hash-edit input (starts with ¶PATH#FILE_HASH). Use @HASH→new content format.',
                    },
                    path: {
                        type: 'string',
                        description: 'Legacy: path to file (for backward compat with string replacement)',
                    },
                    oldString: { type: 'string', description: 'Legacy: text to replace' },
                    newString: { type: 'string', description: 'Legacy: replacement text' },
                },
                required: [],
            },
            examples: [
                // Hash-anchored single-line edit
                {
                    name: 'file_hash_edit',
                    arguments: { input: '¶src/config.ts#A1B2\\n@F7G8H9→const port = 8080;' },
                },
                // Hash-anchored multi-line edit
                {
                    name: 'file_hash_edit',
                    arguments: {
                        input: '¶src/config.ts#A1B2\\n@F7G8H9,I0J1K2→\\nconst port = 8080;\\nconst host = \"0.0.0.0\";',
                    },
                },
            ],
            category: 'filesystem',
        };
    }
    async execute(args) {
        var _a, _b, _c, _d;
        const input = String((_a = args.input) !== null && _a !== void 0 ? _a : '');
        // Detect mode: hash-edit or legacy
        if (input && (0, hashAnchoredEditor_1.isHashEditFormat)(input)) {
            return (0, hashAnchoredEditor_1.parseAndApplyHashEdit)(input);
        }
        // Fallback to hashline format
        if (input && (0, hashline_1.isHashlineFormat)(input)) {
            const parsed = (0, hashline_1.parseHashline)(input);
            if (parsed.errors.length > 0) {
                return `Hashline parse errors:\n${parsed.errors.join('\n')}`;
            }
            const results = [];
            for (const section of parsed.sections) {
                try {
                    const resolved = (0, fileSystemTool_1.safePath)(section.filePath);
                    section.filePath = resolved;
                    const result = (0, hashline_1.applyHashlineSection)(section);
                    if (result.success) {
                        let msg = `✅ ${section.filePath}`;
                        if (result.replacements)
                            msg += ` (${result.replacements} op(s))`;
                        if (result.newHash)
                            msg += ` [hash: ${result.newHash}]`;
                        results.push(msg);
                    }
                    else {
                        results.push(`❌ ${section.filePath}: ${result.error}`);
                    }
                }
                catch (err) {
                    results.push(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            return results.join('\n');
        }
        // Legacy string replacement
        const filePath = String((_b = args.path) !== null && _b !== void 0 ? _b : '');
        const oldStr = String((_c = args.oldString) !== null && _c !== void 0 ? _c : '');
        const newStr = String((_d = args.newString) !== null && _d !== void 0 ? _d : '');
        if (!filePath || !oldStr) {
            return 'Error: Provide input in @hash→content format, or use path+oldString+newString for legacy replacement. Read the file with file_read(includeHashes:true) to get content hashes.';
        }
        try {
            const resolved = (0, fileSystemTool_1.safePath)(filePath);
            if (!fs.existsSync(resolved))
                return `Error: file not found: ${filePath}`;
            let content = fs.readFileSync(resolved, 'utf-8');
            const idx = content.indexOf(oldStr);
            if (idx === -1)
                return `Error: oldString not found in ${filePath}. Try re-reading the file with includeHashes:true and use @hash→content format.`;
            const occurrences = content.split(oldStr).length - 1;
            content = content.split(oldStr).join(newStr);
            await (0, atomicWrite_1.atomicWriteFile)(resolved, content, { encoding: 'utf-8' });
            (0, snapshotStore_1.getSnapshotStore)().record(resolved, content);
            return `✅ ${filePath}: replaced ${occurrences} occurrence(s)`;
        }
        catch (err) {
            return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
exports.FileHashEditTool = FileHashEditTool;
