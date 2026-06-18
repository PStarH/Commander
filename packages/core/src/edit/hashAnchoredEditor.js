"use strict";
/**
 * HashAnchoredEditor — Content-hash-anchored file edits.
 *
 * Inspired by OhMyPi's hashline-anchored edits: instead of line numbers (which
 * drift), edits are anchored to content hashes. The LLM reads a file, gets
 * per-line content hashes, then references those hashes in edit operations.
 *
 * Key properties:
 * - Content hashes are SHA-256 truncated to 6 hex chars per line
 * - Edit format: @CONTENT_HASH→replacement (single-line) or
 *   @HASH1,HASH2→multi-line replacement
 * - 61% token reduction vs. retyping old content
 * - Drift-proof: hashes stay valid even when line numbers shift
 * - Collision detection: warns if two different lines share a hash
 *
 * File read output (enhanced):
 *   ¶src/config.ts#A1B2
 *     1:import { foo } from 'bar';                                #D4E5F6
 *     2:                                                          #A1B2C3
 *     3:const port = 3000;                                        #F7G8H9
 *
 * Edit format:
 *   ¶src/config.ts#A1B2
 *   @F7G8H9→const port = 8080;
 *
 * Multi-line edit:
 *   ¶src/config.ts#A1B2
 *   @F7G8H9,I0J1K2→
 *   const port = 8080;
 *   const host = '0.0.0.0';
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
exports.computeLineHash = computeLineHash;
exports.computeFileAnchors = computeFileAnchors;
exports.findAnchor = findAnchor;
exports.findAnchorRange = findAnchorRange;
exports.formatAnchoredOutput = formatAnchoredOutput;
exports.parseHashEdit = parseHashEdit;
exports.applyHashEdit = applyHashEdit;
exports.isHashEditFormat = isHashEditFormat;
exports.parseAndApplyHashEdit = parseAndApplyHashEdit;
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
const snapshotStore_1 = require("./snapshotStore");
// ============================================================================
// Constants
// ============================================================================
/** Length of content hash (hex chars) */
const CONTENT_HASH_LENGTH = 6;
/** Edit anchor sigil */
const ANCHOR_SIGIL = '@';
/** Replacement separator (Unicode → and ASCII -> both accepted) */
const REPLACEMENT_SEPS = ['→', '->'];
/** Find the replacement separator position in a string. Returns -1 if not found. */
function findReplacementSep(line) {
    for (const sep of REPLACEMENT_SEPS) {
        const idx = line.indexOf(sep);
        if (idx !== -1)
            return idx;
    }
    return -1;
}
/** Get the replacement separator used in a string. Returns '' if not found. */
function getReplacementSep(line) {
    for (const sep of REPLACEMENT_SEPS) {
        if (line.includes(sep))
            return sep;
    }
    return '';
}
/** File-header prefix (same as hashline) */
const FILE_PREFIX = '¶';
/** Hash separator in file header */
const HASH_SEP = '#';
// ============================================================================
// Content Hash Computation
// ============================================================================
/**
 * Compute a content hash for a single line of text.
 * Uses SHA-256 truncated to CONTENT_HASH_LENGTH hex chars.
 * The hash includes the line content normalized (trailing whitespace stripped).
 */
function computeLineHash(content) {
    const normalized = content.replace(/\s+$/g, ''); // Strip trailing whitespace only
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    return hash.slice(0, CONTENT_HASH_LENGTH).toUpperCase();
}
/**
 * Compute content hashes for all lines in a file.
 * Returns an array of ContentHashAnchors, one per line.
 * Also detects hash collisions and returns warnings.
 */
function computeFileAnchors(filePath, content) {
    const lines = content.split('\n');
    const anchors = [];
    const warnings = [];
    const hashSeen = new Map(); // hash → first line number
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hash = computeLineHash(line);
        const lineNum = i + 1;
        anchors.push({
            hash,
            content: line,
            lineNumber: lineNum,
        });
        // Collision detection (compare normalized content to match hash normalization)
        const firstSeen = hashSeen.get(hash);
        if (firstSeen !== undefined) {
            const firstContent = lines[firstSeen - 1];
            const thisContent = line;
            // Normalize both for comparison (matching computeLineHash normalization)
            if (firstContent.replace(/\s+$/g, '') !== thisContent.replace(/\s+$/g, '')) {
                // True collision: same hash, different normalized content
                warnings.push(`Content hash collision in ${filePath}: lines ${firstSeen} and ${lineNum} ` +
                    `have different content but share hash ${hash}. ` +
                    `Use file-level anchors or re-read with a different line range.`);
            }
            // Same normalized content, different line = duplicate line, not a collision
        }
        else {
            hashSeen.set(hash, lineNum);
        }
    }
    return { anchors, warnings };
}
/**
 * Find an anchor by hash in a file's anchors array.
 * Returns the anchor or undefined if not found.
 */
function findAnchor(anchors, hash) {
    return anchors.find((a) => a.hash === hash);
}
/**
 * Find a contiguous range of anchors matching a list of hashes.
 * Returns the anchors in order, or undefined if any hash is not found
 * or if the anchors are not contiguous.
 */
function findAnchorRange(anchors, hashes) {
    if (hashes.length === 0)
        return undefined;
    const results = [];
    let searchFrom = 0;
    for (const hash of hashes) {
        const found = anchors.slice(searchFrom).find((a) => a.hash === hash);
        if (!found)
            return undefined;
        // Check contiguity (except for the first match)
        if (results.length > 0) {
            const last = results[results.length - 1];
            if (found.lineNumber !== last.lineNumber + 1) {
                return undefined; // Not contiguous
            }
        }
        results.push(found);
        searchFrom = anchors.indexOf(found) + 1;
    }
    return results;
}
// ============================================================================
// Anchor Display Formatting
// ============================================================================
/**
 * Format file content with hashline header + numbered lines + per-line hashes.
 * Use this in file_read output to expose content hashes to the LLM.
 */
function formatAnchoredOutput(filePath, content, options) {
    const { offset = 1, limit, maxChars = 50000, includeHashes = true } = options !== null && options !== void 0 ? options : {};
    const { anchors } = computeFileAnchors(filePath, content);
    const fileHash = (0, snapshotStore_1.computeFileHash)(content);
    const allLines = content.split('\n');
    const startIdx = offset - 1;
    const endIdx = limit ? Math.min(startIdx + limit, allLines.length) : allLines.length;
    const displayLines = allLines.slice(startIdx, endIdx);
    const lines = [];
    // File header
    lines.push(`¶${filePath}#${fileHash}`);
    // Numbered lines with optional hashes
    for (let i = 0; i < displayLines.length; i++) {
        const lineNum = startIdx + i + 1;
        const anchor = anchors[startIdx + i];
        if (includeHashes && anchor) {
            // Format: "  LINE:content                                                     #HASH"
            // Pad content to align hashes at column 70
            const lineDisplay = `  ${String(lineNum).padStart(4)}:${displayLines[i]}`;
            const padding = Math.max(1, 72 - lineDisplay.length);
            lines.push(`${lineDisplay}${' '.repeat(padding)}#${anchor.hash}`);
        }
        else {
            lines.push(`  ${String(lineNum).padStart(4)}:${displayLines[i]}`);
        }
    }
    // Truncation info
    if (startIdx > 0 || endIdx < allLines.length) {
        lines.push(`[Lines ${startIdx + 1}-${endIdx} of ${allLines.length}]`);
    }
    const result = lines.join('\n');
    if (result.length > maxChars) {
        return result.slice(0, maxChars) + `\n...[truncated ${result.length - maxChars} chars]`;
    }
    return result;
}
// ============================================================================
// Hash-Edit Format Parser
// ============================================================================
/**
 * Parse hash-anchored edit input.
 *
 * Format:
 *   ¶PATH#FILE_HASH
 *   @CONTENT_HASH→replacement text
 *   @HASH1,HASH2→
 *   multi-line
 *   replacement
 *
 * Returns parsed sections with errors for malformed input.
 */
function parseHashEdit(input) {
    const sections = [];
    const errors = [];
    const lines = input.split('\n');
    let currentSection = null;
    let currentOp = null;
    let inMultiLine = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        // Skip empty lines
        if (!trimmed) {
            // Empty line within multi-line replacement = literal newline
            if (inMultiLine && currentOp) {
                currentOp.replacement += '\n';
            }
            continue;
        }
        // Skip patch envelope markers
        if (trimmed === '*** Begin Patch' || trimmed === '*** End Patch')
            continue;
        // File section header: ¶PATH#FILE_HASH
        if (trimmed.startsWith(FILE_PREFIX)) {
            // Save previous section/op
            if (currentOp && currentSection) {
                currentSection.ops.push(currentOp);
                currentOp = null;
                inMultiLine = false;
            }
            if (currentSection) {
                sections.push(currentSection);
            }
            const headerResult = parseHashEditHeader(trimmed);
            if (headerResult.error) {
                errors.push(headerResult.error);
                currentSection = null;
                continue;
            }
            currentSection = {
                filePath: headerResult.path,
                expectedFileHash: headerResult.hash,
                ops: [],
            };
            continue;
        }
        if (!currentSection) {
            errors.push(`Line ${i + 1}: Content without file header. Start with '¶path#FILE_HASH'.`);
            continue;
        }
        // Anchor operation: @HASH->replacement or @HASH1,HASH2->replacement
        // Accepts both Unicode → and ASCII ->
        if (trimmed.startsWith(ANCHOR_SIGIL)) {
            // Save previous op
            if (currentOp) {
                currentSection.ops.push(currentOp);
                currentOp = null;
                inMultiLine = false;
            }
            const sep = getReplacementSep(trimmed);
            if (!sep) {
                errors.push(`Line ${i + 1}: Missing separator. Format: @HASH->replacement (use -> or →).`);
                continue;
            }
            const opResult = parseHashEditOp(trimmed, sep);
            if (opResult.error) {
                errors.push(`Line ${i + 1}: ${opResult.error}`);
                continue;
            }
            currentOp = opResult.op;
            // Check if this is a single-line replacement (has text after →)
            // or multi-line replacement (arrow at end of line or empty after)
            const sepIdx = trimmed.indexOf(sep);
            const afterSep = trimmed.slice(sepIdx + sep.length).trim();
            if (!afterSep) {
                inMultiLine = true;
                currentOp.replacement = '';
            }
            continue;
        }
        // Body lines for multi-line replacement
        if (inMultiLine && currentOp) {
            currentOp.replacement += raw + '\n';
            continue;
        }
        // Legacy hashline operation headers (replace N..M:, delete N, insert ...) — pass through
        if (trimmed.match(/^(replace|delete|insert)\s/)) {
            // Save previous op
            if (currentOp) {
                currentSection.ops.push(currentOp);
                currentOp = null;
                inMultiLine = false;
            }
            // Convert to a hash-edit op with no hashes (pass-through to hashline parser)
            // We'll handle these as unresolved anchors
            errors.push(`Line ${i + 1}: Legacy hashline format detected. ` +
                `Use content-hash format: @HASH→replacement instead of 'replace N..M:'. ` +
                `Content hashes are shown in file_read output as #XXXXXX at the end of each line.`);
            continue;
        }
        // Body rows starting with + (legacy hashline body)
        if (trimmed.startsWith('+')) {
            errors.push(`Line ${i + 1}: Legacy hashline body row detected. ` +
                `Use content-hash format: @HASH→replacement.`);
            continue;
        }
        errors.push(`Line ${i + 1}: Unrecognized content: "${trimmed.slice(0, 50)}"`);
    }
    // Save final section/op
    if (currentOp && currentSection) {
        currentSection.ops.push(currentOp);
    }
    if (currentSection) {
        sections.push(currentSection);
    }
    return { sections, errors };
}
function parseHashEditHeader(line) {
    if (!line.startsWith(FILE_PREFIX)) {
        return { error: `Not a file header: "${line}"` };
    }
    const withoutPrefix = line.slice(FILE_PREFIX.length);
    const hashIndex = withoutPrefix.lastIndexOf(HASH_SEP);
    if (hashIndex === -1) {
        return { error: `Missing file hash. Expected: ¶path#FILE_HASH. Got: "${line}"` };
    }
    const filePath = withoutPrefix.slice(0, hashIndex).trim();
    const hash = withoutPrefix.slice(hashIndex + 1).trim();
    if (!filePath) {
        return { error: `Empty file path in header: "${line}"` };
    }
    if (!/^[0-9A-Fa-f]{1,8}$/.test(hash)) {
        return { error: `Invalid file hash "${hash}" (must be 1-8 hex chars)` };
    }
    return { path: filePath, hash: hash.toUpperCase() };
}
function parseHashEditOp(line, sep) {
    // Remove leading @
    const withoutSigil = line.slice(1);
    // Find the separator
    const sepIndex = withoutSigil.indexOf(sep);
    if (sepIndex === -1) {
        return { error: `Missing separator. Format: @HASH${sep}replacement` };
    }
    const hashesPart = withoutSigil.slice(0, sepIndex).trim();
    const replacementPart = withoutSigil.slice(sepIndex + sep.length).trim();
    // Parse hashes (comma-separated)
    const hashes = hashesPart
        .split(',')
        .map((h) => h.trim().toUpperCase())
        .filter((h) => h.length > 0);
    if (hashes.length === 0) {
        return { error: `No content hash specified. Format: @HASH→replacement` };
    }
    for (const h of hashes) {
        if (!/^[0-9A-F]{6}$/.test(h)) {
            return { error: `Invalid content hash "${h}" (must be 6 hex chars, e.g., A1B2C3)` };
        }
    }
    return {
        op: {
            hashes,
            replacement: replacementPart,
        },
    };
}
// ============================================================================
// Hash-Edit Applicator
// ============================================================================
/**
 * Apply a parsed hash-edit section to a file.
 *
 * Steps:
 * 1. Read the file
 * 2. Validate file-level hash
 * 3. Compute content anchors
 * 4. Resolve content hashes to line positions
 * 5. Apply replacements (in reverse order to preserve line positions)
 * 6. Atomic write
 */
function applyHashEdit(section) {
    const store = (0, snapshotStore_1.getSnapshotStore)();
    // 1. Read file
    let content;
    try {
        content = fs.readFileSync(section.filePath, 'utf-8');
    }
    catch (err) {
        return {
            success: false,
            filePath: section.filePath,
            error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    // 2. Validate file-level hash
    const currentFileHash = (0, snapshotStore_1.computeFileHash)(content);
    if (currentFileHash !== section.expectedFileHash) {
        // Try snapshot recovery
        const snapshot = store.get(section.filePath);
        if (snapshot && snapshot.hash === section.expectedFileHash) {
            content = snapshot.lines.join('\n');
            // Recovery is best-effort — concurrent edits may be lost.
            // The LLM should re-read the file if the edit was based on a stale hash.
        }
        else {
            return {
                success: false,
                filePath: section.filePath,
                error: `Stale file hash for ${section.filePath}: expected ${section.expectedFileHash}, got ${currentFileHash}. File changed since last read. Re-read the file before editing.`,
            };
        }
    }
    // 3. Compute content anchors from current file content
    const { anchors } = computeFileAnchors(section.filePath, content);
    // 4. Resolve hashes to line ranges for each operation
    const unresolvedAnchors = [];
    const resolvedOps = [];
    for (const op of section.ops) {
        if (op.hashes.length === 1) {
            // Single-line replacement
            const anchor = findAnchor(anchors, op.hashes[0]);
            if (!anchor) {
                unresolvedAnchors.push(op.hashes[0]);
                continue;
            }
            resolvedOps.push({
                startLine: anchor.lineNumber,
                endLine: anchor.lineNumber,
                replacement: op.replacement,
            });
        }
        else {
            // Multi-line range replacement
            const range = findAnchorRange(anchors, op.hashes);
            if (!range) {
                unresolvedAnchors.push(...op.hashes);
                continue;
            }
            const firstLine = range[0].lineNumber;
            const lastLine = range[range.length - 1].lineNumber;
            resolvedOps.push({
                startLine: firstLine,
                endLine: lastLine,
                replacement: op.replacement,
            });
        }
    }
    if (unresolvedAnchors.length > 0) {
        return {
            success: false,
            filePath: section.filePath,
            error: `${unresolvedAnchors.length} content hash(es) not found: ${unresolvedAnchors.slice(0, 5).join(', ')}${unresolvedAnchors.length > 5 ? '...' : ''}. File content may have changed — re-read the file.`,
            unresolvedAnchors,
        };
    }
    // 5. Apply replacements in reverse line order (bottom-to-top preserves positions)
    const lines = content.split('\n');
    const warnings = [];
    resolvedOps.sort((a, b) => b.startLine - a.startLine);
    for (const op of resolvedOps) {
        const startIdx = op.startLine - 1; // 0-indexed
        const endIdx = op.endLine - 1;
        if (startIdx < 0 || startIdx >= lines.length) {
            warnings.push(`Line ${op.startLine} out of range (file has ${lines.length} lines)`);
            continue;
        }
        if (endIdx >= lines.length) {
            warnings.push(`Line ${op.endLine} out of range (file has ${lines.length} lines)`);
            continue;
        }
        // Replace lines
        const replacementLines = op.replacement.split('\n');
        // Remove trailing empty string from split if replacement ends with \n
        if (replacementLines.length > 0 &&
            replacementLines[replacementLines.length - 1] === '' &&
            op.replacement.endsWith('\n')) {
            replacementLines.pop();
        }
        lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
    }
    // 6. Atomic write
    const newContent = lines.join('\n');
    const newHash = (0, snapshotStore_1.computeFileHash)(newContent);
    const tmpPath = section.filePath + `.tmp.${Date.now()}`;
    try {
        fs.writeFileSync(tmpPath, newContent, 'utf-8');
        fs.renameSync(tmpPath, section.filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch {
            /* ignore */
        }
        return {
            success: false,
            filePath: section.filePath,
            error: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    // Update snapshot
    store.record(section.filePath, newContent);
    return {
        success: true,
        filePath: section.filePath,
        newContent,
        newHash,
        replacements: resolvedOps.length,
        warnings: warnings.length > 0 ? warnings : undefined,
    };
}
// ============================================================================
// Convenience: batch apply
// ============================================================================
/**
 * Check if input looks like hash-edit format (starts with ¶ and contains @hash→).
 */
function isHashEditFormat(input) {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith('¶'))
        return false;
    // Must have at least one @HASH→ or @HASH-> operation
    const hasSeparator = trimmed.match(/@[0-9A-F]{6,}(?:→|->)/i);
    return hasSeparator !== null;
}
/**
 * Parse AND apply hash-edit input in one call.
 * Returns combined results for all sections.
 */
function parseAndApplyHashEdit(input) {
    const parsed = parseHashEdit(input);
    if (parsed.errors.length > 0 && parsed.sections.length === 0) {
        return `Hash-edit parse errors:\n${parsed.errors.join('\n')}`;
    }
    const results = [];
    // Report parse errors as warnings if there are also valid sections
    if (parsed.errors.length > 0) {
        results.push(`Warnings:\n${parsed.errors.join('\n')}\n`);
    }
    for (const section of parsed.sections) {
        const result = applyHashEdit(section);
        if (result.success) {
            let msg = `✅ ${section.filePath}`;
            if (result.replacements)
                msg += ` (${result.replacements} edit(s))`;
            if (result.newHash)
                msg += ` [hash: ${result.newHash}]`;
            if (result.warnings)
                msg += `\n  Warnings: ${result.warnings.join(', ')}`;
            results.push(msg);
        }
        else {
            results.push(`❌ ${section.filePath}: ${result.error}`);
        }
    }
    return results.join('\n');
}
