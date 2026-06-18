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
exports.SkillViewTool = void 0;
const logging_1 = require("../logging");
const DEFINITION = {
    name: 'skill_view',
    description: 'Load full skill instructions by name. Use this when a skill from the Available Skills catalog matches your current task. Returns the complete skill content with step-by-step instructions.',
    inputSchema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'The skill name to load (from the Available Skills catalog).',
            },
        },
        required: ['name'],
    },
    category: 'knowledge',
};
class SkillViewTool {
    constructor() {
        this.definition = DEFINITION;
        this.isConcurrencySafe = true;
        this.isReadOnly = true;
        this.timeout = 5000;
        this.maxOutputSize = 20000;
    }
    async execute(args) {
        var _a;
        const name = String((_a = args.name) !== null && _a !== void 0 ? _a : '');
        if (!name)
            return 'Error: skill name is required.';
        try {
            const { getSkillSystem } = await Promise.resolve().then(() => __importStar(require('./index')));
            const skill = await getSkillSystem().manager.get(name);
            if (!skill)
                return `Skill "${name}" not found.`;
            const header = `## ${skill.name}\n${skill.description}\n\n`;
            const meta = [
                `Quality: ${(skill.metadata.qualityScore * 100).toFixed(0)}%`,
                `Usage: ${skill.metadata.usageCount} times`,
                `Category: ${skill.metadata.category}`,
                skill.metadata.tags.length > 0 ? `Tags: ${skill.metadata.tags.join(', ')}` : '',
            ]
                .filter(Boolean)
                .join(' · ');
            return `${header}${meta}\n\n---\n\n${skill.content}`;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logging_1.getGlobalLogger)().warn('SkillViewTool', `Failed to load skill "${name}"`, { error: msg });
            return `Error loading skill "${name}": ${msg}`;
        }
    }
}
exports.SkillViewTool = SkillViewTool;
