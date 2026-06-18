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
exports.ApprovalSystem = void 0;
exports.getApprovalSystem = getApprovalSystem;
exports.resetApprovalSystem = resetApprovalSystem;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const execPolicy_1 = require("./execPolicy");
const logging_1 = require("../logging");
const securityAuditLogger_1 = require("../security/securityAuditLogger");
class ApprovalSystem {
    constructor(execPolicy, persistDir) {
        this.mode = 'suggest';
        this.callback = null;
        this.sessionApprovals = new Set();
        this.deniedForever = new Map();
        this.execPolicy = execPolicy !== null && execPolicy !== void 0 ? execPolicy : new execPolicy_1.ExecPolicyEngine();
        this.persistFile = path.join(persistDir !== null && persistDir !== void 0 ? persistDir : process.cwd(), '.commander', 'approval-mode.json');
        this.loadMode();
    }
    setMode(mode) {
        this.mode = mode;
        this.persistMode();
    }
    getMode() {
        return this.mode;
    }
    persistMode() {
        try {
            const dir = path.dirname(this.persistFile);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.persistFile, JSON.stringify({ mode: this.mode }), 'utf-8');
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().debug('ApprovalSystem', 'Failed to persist mode', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    loadMode() {
        try {
            if (fs.existsSync(this.persistFile)) {
                const data = JSON.parse(fs.readFileSync(this.persistFile, 'utf-8'));
                const validModes = [
                    'suggest',
                    'auto-edit',
                    'full-auto',
                    'read-only',
                    'plan',
                ];
                if (validModes.includes(data.mode)) {
                    this.mode = data.mode;
                }
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().debug('ApprovalSystem', 'Failed to load persisted mode, using default', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    setCallback(cb) {
        this.callback = cb;
    }
    clearSessionApprovals() {
        this.sessionApprovals.clear();
    }
    async evaluate(req) {
        var _a;
        const audit = (0, securityAuditLogger_1.getSecurityAuditLogger)();
        const cacheKey = `${req.toolName}:${JSON.stringify(req.toolArgs)}`;
        if (this.sessionApprovals.has(cacheKey)) {
            return { decision: 'approved_session', reason: 'Previously approved for session' };
        }
        const denyCount = (_a = this.deniedForever.get(cacheKey)) !== null && _a !== void 0 ? _a : 0;
        if (denyCount >= ApprovalSystem.DENIED_THRESHOLD) {
            audit.logExecPolicyForbidden('ApprovalSystem', `Blocked after ${denyCount} consecutive denials`, {
                toolName: req.toolName,
                category: req.gate.category,
                denyCount,
            });
            return { decision: 'denied', reason: `Blocked after ${denyCount} consecutive denials` };
        }
        const policyResult = this.evaluatePolicy(req);
        if (policyResult.decision === 'forbidden') {
            audit.logExecPolicyForbidden('ApprovalSystem', policyResult.reason, {
                toolName: req.toolName,
                category: req.gate.category,
            });
            return { decision: 'denied', reason: policyResult.reason };
        }
        const modeResult = this.evaluateMode(req);
        if (modeResult.decision === 'approved') {
            return { decision: 'approved', reason: modeResult.reason };
        }
        if (modeResult.decision === 'denied') {
            audit.logApprovalDenied('ApprovalSystem', modeResult.reason, {
                toolName: req.toolName,
                category: req.gate.category,
                mode: this.mode,
            });
            return { decision: 'denied', reason: modeResult.reason };
        }
        if (this.callback) {
            const cbDecision = await this.callback(req);
            if (cbDecision === 'approved_once') {
                return { decision: 'approved_once', reason: 'Approved by callback' };
            }
            if (cbDecision === 'approved_session') {
                this.sessionApprovals.add(cacheKey);
                if (this.sessionApprovals.size > ApprovalSystem.MAX_CACHE_SIZE) {
                    const first = this.sessionApprovals.values().next().value;
                    if (first)
                        this.sessionApprovals.delete(first);
                }
                return { decision: 'approved_session', reason: 'Approved for session' };
            }
            if (cbDecision === 'denied_forever') {
                this.deniedForever.set(cacheKey, denyCount + 1);
                if (this.deniedForever.size > ApprovalSystem.MAX_CACHE_SIZE) {
                    const first = this.deniedForever.keys().next().value;
                    if (first)
                        this.deniedForever.delete(first);
                }
                audit.logApprovalDenied('ApprovalSystem', 'Permanently denied by user callback', {
                    toolName: req.toolName,
                    category: req.gate.category,
                });
                return { decision: 'denied', reason: 'Denied by callback' };
            }
            return { decision: cbDecision, reason: 'Callback decision' };
        }
        // No callback and mode defers: safe default is deny
        if (modeResult.decision === 'defer') {
            audit.logApprovalDenied('ApprovalSystem', `No approval callback: ${modeResult.reason}`, {
                toolName: req.toolName,
                category: req.gate.category,
                mode: this.mode,
            });
            return { decision: 'denied', reason: `No approval callback available: ${modeResult.reason}` };
        }
        return { decision: 'approved', reason: 'No approval required' };
    }
    evaluatePolicy(req) {
        var _a, _b, _c, _d;
        const action = `${req.toolName} ${JSON.stringify(req.toolArgs)}`;
        const result = this.execPolicy.evaluate(action);
        if (result.decision === 'forbidden') {
            return {
                decision: 'forbidden',
                reason: `Blocked by policy: ${(_b = (_a = result.rule) === null || _a === void 0 ? void 0 : _a.justification) !== null && _b !== void 0 ? _b : 'Dangerous operation'}`,
            };
        }
        if (result.decision === 'prompt') {
            return {
                decision: 'prompt',
                reason: `Policy requires review: ${(_d = (_c = result.rule) === null || _c === void 0 ? void 0 : _c.justification) !== null && _d !== void 0 ? _d : 'Needs approval'}`,
            };
        }
        return { decision: 'allow', reason: 'Allowed by policy' };
    }
    evaluateMode(req) {
        const isWrite = req.gate.category === 'file_write' || req.gate.category === 'shell_exec';
        const isDestructive = req.gate.category === 'destructive';
        const isNetwork = req.gate.category === 'network';
        const isSandboxEscape = req.gate.category === 'sandbox_escape';
        switch (this.mode) {
            case 'read-only':
                if (isWrite || isDestructive || isNetwork || isSandboxEscape) {
                    return {
                        decision: 'denied',
                        reason: `Blocked by ${this.mode} mode: ${req.gate.category} not allowed`,
                    };
                }
                return { decision: 'approved', reason: `${this.mode} mode allows reads` };
            case 'plan':
                if (isWrite || isDestructive) {
                    return { decision: 'denied', reason: `Blocked by plan mode: no modifications allowed` };
                }
                return { decision: 'approved', reason: 'Plan mode allows analysis' };
            case 'suggest':
                if (isDestructive || isSandboxEscape) {
                    return {
                        decision: 'defer',
                        reason: `${this.mode} mode: user approval needed for ${req.gate.category}`,
                    };
                }
                return { decision: 'approved', reason: `${this.mode} mode allows this action` };
            case 'auto-edit':
                if (isSandboxEscape) {
                    return {
                        decision: 'defer',
                        reason: `Sandbox escape needs approval even in auto-edit mode`,
                    };
                }
                if (isDestructive) {
                    return { decision: 'defer', reason: `Destructive operations need approval` };
                }
                return { decision: 'approved', reason: `Auto-edit mode allows ${req.gate.category}` };
            case 'full-auto':
                return { decision: 'approved', reason: 'Full-auto mode' };
            default:
                return { decision: 'defer', reason: `Unknown mode ${this.mode}, deferring` };
        }
    }
}
exports.ApprovalSystem = ApprovalSystem;
ApprovalSystem.MAX_CACHE_SIZE = 5000;
ApprovalSystem.DENIED_THRESHOLD = 3;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const approvalSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ApprovalSystem());
function getApprovalSystem() {
    return approvalSingleton.get();
}
function resetApprovalSystem() {
    approvalSingleton.reset();
}
