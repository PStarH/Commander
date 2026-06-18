"use strict";
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
exports.SkillStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const SKILLS_DIR = path.join(process.cwd(), '.commander', 'skills');
const LEGACY_SKILLS_DIR = path.join(process.cwd(), '.commander_skills');
/**
 * Minimal YAML frontmatter parser. Handles the subset of YAML used in
 * agentskills.io SKILL.md files: nested objects, arrays, strings, numbers, booleans.
 */
function parseYamlFrontmatter(yaml) {
    const result = {};
    const lines = yaml.split('\n');
    const stack = [
        { obj: result, indent: -1 },
    ];
    const arrayStack = [];
    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '');
        if (!line.trim() || line.trim().startsWith('#'))
            continue;
        const indent = line.search(/\S/);
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
            const value = parseYamlValue(trimmed.slice(2));
            if (arrayStack.length > 0) {
                arrayStack[arrayStack.length - 1].arr.push(value);
            }
            continue;
        }
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1)
            continue;
        const key = trimmed.slice(0, colonIdx).trim();
        const valueStr = trimmed.slice(colonIdx + 1).trim();
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
            stack.pop();
        }
        // Pop stale array context when indentation decreases
        while (arrayStack.length > 0 &&
            indent <= arrayStack[arrayStack.length - 1]._indent) {
            arrayStack.pop();
        }
        const currentObj = stack[stack.length - 1].obj;
        if (valueStr === '') {
            // Peek at next non-empty line to decide if this is an array or object
            let nextLine = '';
            for (let li = lines.indexOf(rawLine) + 1; li < lines.length; li++) {
                const nl = lines[li].replace(/\s+$/, '');
                if (nl.trim() && !nl.trim().startsWith('#')) {
                    nextLine = nl;
                    break;
                }
            }
            const nextIndent = nextLine.search(/\S/);
            const nextTrimmed = nextLine.trim();
            if (nextTrimmed.startsWith('- ') && nextIndent > indent) {
                // This key starts an array
                const arr = [];
                currentObj[key] = arr;
                arrayStack.push({ arr, key, _indent: indent });
            }
            else {
                const nested = {};
                currentObj[key] = nested;
                stack.push({ obj: nested, indent });
            }
        }
        else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
            currentObj[key] = valueStr
                .slice(1, -1)
                .split(',')
                .map((s) => parseYamlValue(s.trim()))
                .filter((s) => s !== '');
        }
        else {
            currentObj[key] = parseYamlValue(valueStr);
        }
    }
    return result;
}
function parseYamlValue(value) {
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    if (value === 'null' || value === '~')
        return null;
    const num = Number(value);
    if (!isNaN(num) && value !== '')
        return num;
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
        return value.slice(1, -1);
    }
    return value;
}
function serializeYamlValue(value, indent) {
    const pad = '  '.repeat(indent);
    if (typeof value === 'string') {
        if (value.includes('\n') || value.includes(':') || value.includes('#')) {
            return `'${value.replace(/'/g, "''")}'`;
        }
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (value === null || value === undefined)
        return '~';
    return String(value);
}
function serializeToYaml(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    const lines = [];
    for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined)
            continue;
        if (Array.isArray(value)) {
            if (value.length === 0) {
                lines.push(`${pad}${key}: []`);
            }
            else if (value.every((v) => typeof v !== 'object' || v === null)) {
                const items = value.map((v) => serializeYamlValue(v, indent)).join(', ');
                lines.push(`${pad}${key}: [${items}]`);
            }
            else {
                lines.push(`${pad}${key}:`);
                for (const item of value) {
                    if (typeof item === 'object' && item !== null) {
                        lines.push(`${pad}-`);
                        for (const [ik, iv] of Object.entries(item)) {
                            lines.push(`${pad}  ${ik}: ${serializeYamlValue(iv, indent + 2)}`);
                        }
                    }
                    else {
                        lines.push(`${pad}- ${serializeYamlValue(item, indent + 1)}`);
                    }
                }
            }
        }
        else if (typeof value === 'object' && value !== null) {
            lines.push(`${pad}${key}:`);
            lines.push(serializeToYaml(value, indent + 1));
        }
        else {
            lines.push(`${pad}${key}: ${serializeYamlValue(value, indent)}`);
        }
    }
    return lines.join('\n');
}
/**
 * Parse a SKILL.md file (YAML frontmatter + markdown body).
 * Returns the frontmatter as a structured object and the body as a string.
 */
function parseSkillMd(content) {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('---'))
        return null;
    const endIdx = trimmed.indexOf('---', 3);
    if (endIdx === -1)
        return null;
    const yamlBlock = trimmed.slice(3, endIdx).trim();
    const body = trimmed.slice(endIdx + 3).trim();
    return {
        frontmatter: parseYamlFrontmatter(yamlBlock),
        body,
    };
}
/**
 * Convert agentskills.io frontmatter (snake_case) to internal Skill type.
 */
function frontmatterToSkill(name, fm, body) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const meta = (_a = fm.metadata) !== null && _a !== void 0 ? _a : {};
    const now = new Date().toISOString();
    const allowedTools = fm['allowed-tools'];
    return {
        id: (_b = fm.name) !== null && _b !== void 0 ? _b : name,
        name: (_c = fm.name) !== null && _c !== void 0 ? _c : name,
        description: (_d = fm.description) !== null && _d !== void 0 ? _d : '',
        content: body,
        tools: typeof allowedTools === 'string' ? allowedTools.split(/\s+/).filter(Boolean) : [],
        metadata: {
            category: (_e = meta.category) !== null && _e !== void 0 ? _e : 'general',
            tags: (_f = meta.tags) !== null && _f !== void 0 ? _f : [],
            source: (_g = meta.source) !== null && _g !== void 0 ? _g : 'learned',
            qualityScore: (_h = meta.quality_score) !== null && _h !== void 0 ? _h : 0.5,
            usageCount: (_j = meta.usage_count) !== null && _j !== void 0 ? _j : 0,
            avgSuccessRate: (_k = meta.avg_success_rate) !== null && _k !== void 0 ? _k : 0.5,
            autoGenerated: (_l = meta.auto_generated) !== null && _l !== void 0 ? _l : false,
            pinned: (_m = meta.pinned) !== null && _m !== void 0 ? _m : false,
            generatedFrom: meta.generated_from,
            createdAt: now,
            updatedAt: now,
        },
    };
}
/**
 * Convert internal Skill to SKILL.md format with YAML frontmatter.
 */
function skillToMarkdown(skill) {
    const fm = {
        name: skill.name,
        description: skill.description,
        license: 'MIT',
        compatibility: 'commander',
        version: '1.0',
        metadata: {
            category: skill.metadata.category,
            tags: skill.metadata.tags,
            source: skill.metadata.source,
            quality_score: skill.metadata.qualityScore,
            usage_count: skill.metadata.usageCount,
            avg_success_rate: skill.metadata.avgSuccessRate,
            auto_generated: skill.metadata.autoGenerated,
            pinned: skill.metadata.pinned,
            generated_from: skill.metadata.generatedFrom,
        },
        'allowed-tools': skill.tools.length > 0 ? skill.tools.join(' ') : undefined,
    };
    const yaml = serializeToYaml(fm);
    return `---\n${yaml}\n---\n\n${skill.content}`;
}
class SkillStore {
    constructor(skillsDir) {
        this.skillsDir = skillsDir !== null && skillsDir !== void 0 ? skillsDir : SKILLS_DIR;
        this.ensureDir();
    }
    ensureDir() {
        if (!fs.existsSync(this.skillsDir)) {
            fs.mkdirSync(this.skillsDir, { recursive: true });
        }
    }
    skillDir(name) {
        return path.join(this.skillsDir, sanitizeName(name));
    }
    /** Public accessor for SkillCurator to get the skill directory path. */
    getSkillPath(name) {
        return this.skillDir(name);
    }
    skillMdPath(name) {
        return path.join(this.skillDir(name), 'SKILL.md');
    }
    async save(skill) {
        if (!validateSkillName(skill.name)) {
            throw new Error(`Invalid skill name "${skill.name}": must be 1-64 chars, lowercase alphanumeric with hyphens`);
        }
        checkBodyLength(skill.content);
        this.ensureDir();
        const dir = this.skillDir(skill.name);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const content = skillToMarkdown(skill);
        fs.writeFileSync(this.skillMdPath(skill.name), content, 'utf-8');
    }
    async load(name) {
        try {
            const fp = this.skillMdPath(name);
            if (!fs.existsSync(fp))
                return null;
            const raw = fs.readFileSync(fp, 'utf-8');
            const parsed = parseSkillMd(raw);
            if (!parsed)
                return null;
            return frontmatterToSkill(name, parsed.frontmatter, parsed.body);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('SkillStore', `Failed to load skill "${name}"`, {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
            return null;
        }
    }
    async delete(name) {
        try {
            const dir = this.skillDir(name);
            if (!fs.existsSync(dir))
                return false;
            fs.rmSync(dir, { recursive: true, force: true });
            return true;
        }
        catch {
            return false;
        }
    }
    async list() {
        this.ensureDir();
        try {
            return fs.readdirSync(this.skillsDir).filter((f) => {
                try {
                    return fs.statSync(path.join(this.skillsDir, f)).isDirectory();
                }
                catch {
                    return false;
                }
            });
        }
        catch {
            return [];
        }
    }
    async exists(name) {
        return fs.existsSync(this.skillMdPath(name));
    }
    async loadAll() {
        const names = await this.list();
        const results = [];
        for (const name of names) {
            const skill = await this.load(name);
            if (skill)
                results.push(skill);
        }
        return results;
    }
    /**
     * Migrate from old JSON skill format to new SKILL.md format.
     * Old format: .commander_skills/<name>.json or .commander/skills/<name>.json
     * Returns count of migrated skills.
     */
    async migrateFromJson() {
        var _a, _b, _c, _d, _e, _f;
        let migrated = 0;
        const jsonDirs = [
            path.join(process.cwd(), '.commander_skills'),
            path.join(process.cwd(), '.commander', 'skills'),
        ];
        for (const dir of jsonDirs) {
            if (!fs.existsSync(dir))
                continue;
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const name = file.replace(/\.json$/, '');
                // Skip if already migrated
                if (await this.exists(name))
                    continue;
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                    const skill = {
                        id: name,
                        name: (_a = data.name) !== null && _a !== void 0 ? _a : name,
                        description: (_b = data.description) !== null && _b !== void 0 ? _b : '',
                        content: (_c = data.prompt) !== null && _c !== void 0 ? _c : '',
                        tools: (_d = data.tools) !== null && _d !== void 0 ? _d : [],
                        metadata: {
                            category: 'general',
                            tags: [],
                            source: 'learned',
                            qualityScore: 0.5,
                            usageCount: (_e = data.usageCount) !== null && _e !== void 0 ? _e : 0,
                            avgSuccessRate: 0.5,
                            autoGenerated: false,
                            pinned: false,
                            createdAt: (_f = data.createdAt) !== null && _f !== void 0 ? _f : new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        },
                    };
                    await this.save(skill);
                    migrated++;
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('SkillStore', `Migration failed for "${name}"`, {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
            }
        }
        return migrated;
    }
}
exports.SkillStore = SkillStore;
function sanitizeName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
/** Validate skill name per agentskills.io spec: 1-64 chars, lowercase alphanumeric + hyphens. */
function validateSkillName(name) {
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length >= 1 && name.length <= 64;
}
/** Warn if SKILL.md body exceeds spec recommendation (500 lines / 5000 tokens). */
function checkBodyLength(body) {
    const lines = body.split('\n').length;
    const tokens = body.split(/\s+/).length;
    if (lines > 500 || tokens > 5000) {
        (0, logging_1.getGlobalLogger)().warn('SkillStore', `Skill body exceeds recommended limits: ${lines} lines, ${tokens} tokens (max 500 lines / 5000 tokens)`);
    }
}
