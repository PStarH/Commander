"use strict";
/**
 * Skill System — agentskills.io compatible, MetaLearner-bridged.
 *
 * Each skill is a directory in .commander/skills/<name>/ containing SKILL.md
 * with YAML frontmatter (agentskills.io spec) and optional scripts/, references/.
 * Skills teach the agent how to use tools effectively.
 *
 * Three loading levels (progressive disclosure):
 *   Level 0: Skill names only (~3K tokens for full library)
 *   Level 1: Full SKILL.md content for relevant skills
 *   Level 2: Reference files on demand
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
exports.rejectReason = exports.scanSkillContent = exports.buildRubricPrompt = exports.evaluateWithRubric = exports.computeDeterministicScore = exports.computeQualityScore = exports.buildMergePrompt = exports.findSimilarPairs = exports.computeSimilarity = exports.tagSimilarity = exports.descriptionSimilarity = exports.nameSimilarity = exports.jaccardSimilarity = exports.SkillCurator = exports.SkillInjector = exports.MetaLearnerBridge = exports.SkillManager = exports.SkillStore = exports.SkillViewTool = void 0;
exports.createSkill = createSkill;
exports.loadSkill = loadSkill;
exports.listSkills = listSkills;
exports.buildSkillsPrompt = buildSkillsPrompt;
exports.recordSkillUsage = recordSkillUsage;
exports.deleteSkill = deleteSkill;
exports.createSkillSystem = createSkillSystem;
exports.getSkillSystem = getSkillSystem;
exports.resetSkillSystem = resetSkillSystem;
var skillViewTool_1 = require("./skillViewTool");
Object.defineProperty(exports, "SkillViewTool", { enumerable: true, get: function () { return skillViewTool_1.SkillViewTool; } });
var skillStore_1 = require("./skillStore");
Object.defineProperty(exports, "SkillStore", { enumerable: true, get: function () { return skillStore_1.SkillStore; } });
var skillManager_1 = require("./skillManager");
Object.defineProperty(exports, "SkillManager", { enumerable: true, get: function () { return skillManager_1.SkillManager; } });
var metaLearnerBridge_1 = require("./metaLearnerBridge");
Object.defineProperty(exports, "MetaLearnerBridge", { enumerable: true, get: function () { return metaLearnerBridge_1.MetaLearnerBridge; } });
var skillInjector_1 = require("./skillInjector");
Object.defineProperty(exports, "SkillInjector", { enumerable: true, get: function () { return skillInjector_1.SkillInjector; } });
var skillCurator_1 = require("./skillCurator");
Object.defineProperty(exports, "SkillCurator", { enumerable: true, get: function () { return skillCurator_1.SkillCurator; } });
Object.defineProperty(exports, "jaccardSimilarity", { enumerable: true, get: function () { return skillCurator_1.jaccardSimilarity; } });
Object.defineProperty(exports, "nameSimilarity", { enumerable: true, get: function () { return skillCurator_1.nameSimilarity; } });
Object.defineProperty(exports, "descriptionSimilarity", { enumerable: true, get: function () { return skillCurator_1.descriptionSimilarity; } });
Object.defineProperty(exports, "tagSimilarity", { enumerable: true, get: function () { return skillCurator_1.tagSimilarity; } });
Object.defineProperty(exports, "computeSimilarity", { enumerable: true, get: function () { return skillCurator_1.computeSimilarity; } });
Object.defineProperty(exports, "findSimilarPairs", { enumerable: true, get: function () { return skillCurator_1.findSimilarPairs; } });
Object.defineProperty(exports, "buildMergePrompt", { enumerable: true, get: function () { return skillCurator_1.buildMergePrompt; } });
var skillQualityScorer_1 = require("./skillQualityScorer");
Object.defineProperty(exports, "computeQualityScore", { enumerable: true, get: function () { return skillQualityScorer_1.computeQualityScore; } });
Object.defineProperty(exports, "computeDeterministicScore", { enumerable: true, get: function () { return skillQualityScorer_1.computeDeterministicScore; } });
Object.defineProperty(exports, "evaluateWithRubric", { enumerable: true, get: function () { return skillQualityScorer_1.evaluateWithRubric; } });
Object.defineProperty(exports, "buildRubricPrompt", { enumerable: true, get: function () { return skillQualityScorer_1.buildRubricPrompt; } });
var skillSecurityScanner_1 = require("./skillSecurityScanner");
Object.defineProperty(exports, "scanSkillContent", { enumerable: true, get: function () { return skillSecurityScanner_1.scanSkillContent; } });
Object.defineProperty(exports, "rejectReason", { enumerable: true, get: function () { return skillSecurityScanner_1.rejectReason; } });
// ============================================================================
// Legacy backward-compatible API — delegates to the new SkillManager singleton
// ============================================================================
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const skillStore_2 = require("./skillStore");
const skillManager_2 = require("./skillManager");
const skillInjector_2 = require("./skillInjector");
const skillCurator_2 = require("./skillCurator");
const metaLearnerBridge_2 = require("./metaLearnerBridge");
const metaLearner_1 = require("../selfEvolution/metaLearner");
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const LEGACY_SKILLS_DIR = path.join(process.cwd(), '.commander', 'skills');
const skillSystemSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => {
    const store = new skillStore_2.SkillStore();
    const manager = new skillManager_2.SkillManager(store);
    store
        .migrateFromJson()
        .catch((e) => (0, logging_1.getGlobalLogger)().warn('Skills', 'Migration failed', { error: e === null || e === void 0 ? void 0 : e.message }));
    return {
        manager,
        injector: new skillInjector_2.SkillInjector(manager),
        curator: new skillCurator_2.SkillCurator(manager),
        bridge: new metaLearnerBridge_2.MetaLearnerBridge((0, metaLearner_1.getMetaLearner)(), manager),
    };
});
function getManager() {
    return skillSystemSingleton.get().manager;
}
function getBridge() {
    return skillSystemSingleton.get().bridge;
}
/** Legacy: create a skill from explicit fields. */
function createSkill(name, description, tools, prompt) {
    const now = new Date().toISOString();
    const skillDef = {
        name,
        description,
        tools,
        prompt,
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
    };
    getManager()
        .create(name, prompt, {
        category: 'general',
        tags: [],
        source: 'user',
        qualityScore: 0.5,
        usageCount: 0,
        avgSuccessRate: 0.5,
        autoGenerated: false,
        createdAt: now,
        updatedAt: now,
    })
        .catch((e) => (0, logging_1.getGlobalLogger)().warn('Skills', 'Failed to create skill', { error: e === null || e === void 0 ? void 0 : e.message }));
    return skillDef;
}
/** Legacy: load a single skill by name (JSON format fallback). */
function loadSkill(name) {
    try {
        const jsonPath = path.join(LEGACY_SKILLS_DIR, `${name}.json`);
        if (fs.existsSync(jsonPath)) {
            return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        }
    }
    catch {
        return null;
    }
    return null;
}
/** Legacy: list all skills as SkillDef array. */
function listSkills() {
    try {
        if (!fs.existsSync(LEGACY_SKILLS_DIR))
            return [];
        return fs
            .readdirSync(LEGACY_SKILLS_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(LEGACY_SKILLS_DIR, f), 'utf-8'));
            }
            catch {
                return null;
            }
        })
            .filter((s) => s !== null)
            .sort((a, b) => b.usageCount - a.usageCount);
    }
    catch {
        return [];
    }
}
/** Legacy: build system prompt from skills (Level 0 only). */
function buildSkillsPrompt(maxLevel = 0) {
    if (maxLevel === 0) {
        const skills = listSkills();
        if (skills.length === 0)
            return '';
        return ('### Available Skills\n\n' + skills.map((s) => `- ${s.name}: ${s.description}`).join('\n'));
    }
    return ''; // Level 1+ requires async SkillManager
}
/** Legacy: record usage of a skill. */
function recordSkillUsage(name) {
    getManager()
        .recordUsage(name, true)
        .catch((e) => (0, logging_1.getGlobalLogger)().warn('Skills', 'Failed to record usage', { error: e === null || e === void 0 ? void 0 : e.message }));
}
/** Legacy: delete a skill. */
function deleteSkill(name) {
    getManager()
        .delete(name)
        .catch((e) => (0, logging_1.getGlobalLogger)().warn('Skills', 'Failed to delete skill', { error: e === null || e === void 0 ? void 0 : e.message }));
    try {
        const jsonPath = path.join(LEGACY_SKILLS_DIR, `${name}.json`);
        if (fs.existsSync(jsonPath)) {
            fs.unlinkSync(jsonPath);
        }
    }
    catch {
        return false;
    }
    return true;
}
function createSkillSystem() {
    const store = new skillStore_2.SkillStore();
    const manager = new skillManager_2.SkillManager(store);
    const injector = new skillInjector_2.SkillInjector(manager);
    const curator = new skillCurator_2.SkillCurator(manager);
    const bridge = new metaLearnerBridge_2.MetaLearnerBridge((0, metaLearner_1.getMetaLearner)(), manager);
    return { manager, injector, curator, bridge };
}
function getSkillSystem() {
    const sys = skillSystemSingleton.get();
    return {
        manager: sys.manager,
        injector: sys.injector,
        curator: sys.curator,
        bridge: sys.bridge,
    };
}
function resetSkillSystem() {
    skillSystemSingleton.reset();
}
