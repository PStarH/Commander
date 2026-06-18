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
exports.AgentInbox = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
class AgentInbox {
    constructor(baseDir, flushIntervalMs = 5000) {
        this.inboxes = new Map();
        this.dirtyAgents = new Set();
        this.baseDir = baseDir !== null && baseDir !== void 0 ? baseDir : path.join(process.cwd(), '.commander_inboxes');
        fs.mkdirSync(this.baseDir, { recursive: true });
        this.flushTimer = setInterval(() => this.flushDirty(), flushIntervalMs);
        if (typeof this.flushTimer.unref === 'function')
            this.flushTimer.unref();
    }
    dispose() {
        clearInterval(this.flushTimer);
        this.flushDirty();
    }
    /** Send a message to an agent's inbox */
    send(msg) {
        const full = {
            ...msg,
            status: 'unread',
            timestamp: new Date().toISOString(),
        };
        const inbox = this.getOrCreateInbox(msg.to);
        inbox.push(full);
        this.dirtyAgents.add(msg.to);
        this.autoPruneIfNeeded(msg.to);
    }
    /** Get all messages for an agent, optionally filtered by status */
    getMessages(agentId, status) {
        const inbox = this.getOrCreateInbox(agentId);
        let msgs = [...inbox];
        if (status)
            msgs = msgs.filter((m) => m.status === status);
        return msgs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    /** Get unread messages for an agent */
    pollInbox(agentId) {
        const inbox = this.getOrCreateInbox(agentId);
        const unread = [];
        for (const msg of inbox) {
            if (msg.status === 'unread') {
                msg.status = 'read';
                msg.readAt = new Date().toISOString();
                unread.push(msg);
                this.dirtyAgents.add(agentId);
            }
        }
        return unread;
    }
    /** Mark a message as acknowledged (fully processed) */
    acknowledge(agentId, messageId) {
        const inbox = this.getOrCreateInbox(agentId);
        const msg = inbox.find((m) => m.id === messageId);
        if (!msg)
            return false;
        msg.status = 'acknowledged';
        msg.acknowledgedAt = new Date().toISOString();
        this.dirtyAgents.add(agentId);
        return true;
    }
    /** Delete a message from an agent's inbox */
    deleteMessage(agentId, messageId) {
        const inbox = this.getOrCreateInbox(agentId);
        const idx = inbox.findIndex((m) => m.id === messageId);
        if (idx === -1)
            return false;
        inbox.splice(idx, 1);
        this.dirtyAgents.add(agentId);
        return true;
    }
    /** Get inbox size for an agent */
    getInboxSize(agentId) {
        return this.getOrCreateInbox(agentId).length;
    }
    /** Prune expired and acknowledged messages */
    prune(agentId) {
        var _a, _b;
        const agents = agentId ? [agentId] : this.listAgents();
        let pruned = 0;
        for (const id of agents) {
            const inbox = this.getOrCreateInbox(id);
            const before = inbox.length;
            const now = Date.now();
            this.inboxes.set(id, inbox.filter((m) => {
                if (m.status === 'acknowledged')
                    return false;
                if (m.ttlMs) {
                    const age = now - new Date(m.timestamp).getTime();
                    if (age > m.ttlMs)
                        return false;
                }
                return true;
            }));
            const removed = before - ((_b = (_a = this.inboxes.get(id)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0);
            if (removed > 0)
                this.dirtyAgents.add(id);
            pruned += removed;
        }
        return pruned;
    }
    /** List all agents that have inboxes */
    listAgents() {
        const fromDisk = fs
            .readdirSync(this.baseDir)
            .filter((f) => f.endsWith('.ndjson'))
            .map((f) => f.replace('.ndjson', ''));
        const fromMem = Array.from(this.inboxes.keys());
        return Array.from(new Set([...fromDisk, ...fromMem]));
    }
    // ── Persistence ──
    getOrCreateInbox(agentId) {
        let inbox = this.inboxes.get(agentId);
        if (inbox)
            return inbox;
        inbox = this.loadFromDisk(agentId);
        this.inboxes.set(agentId, inbox);
        return inbox;
    }
    /** Auto-prune acknowledged/expired messages from an inbox if it exceeds the threshold */
    autoPruneIfNeeded(agentId) {
        const inbox = this.inboxes.get(agentId);
        if (!inbox || inbox.length < 200)
            return;
        const now = Date.now();
        const before = inbox.length;
        const pruned = inbox.filter((m) => {
            if (m.status === 'acknowledged')
                return false;
            if (m.ttlMs) {
                const age = now - new Date(m.timestamp).getTime();
                if (age > m.ttlMs)
                    return false;
            }
            return true;
        });
        this.inboxes.set(agentId, pruned);
        if (pruned.length < before)
            this.dirtyAgents.add(agentId);
    }
    loadFromDisk(agentId) {
        const filePath = path.join(this.baseDir, `${agentId}.ndjson`);
        if (!fs.existsSync(filePath))
            return [];
        try {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw)
                return [];
            const messages = [];
            for (const line of raw.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    messages.push(JSON.parse(line));
                }
                catch {
                    (0, logging_1.getGlobalLogger)().warn('AgentInbox', 'Skipping corrupt inbox line', { agentId });
                }
            }
            return messages;
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('AgentInbox', 'Failed to load inbox from disk', {
                error: e === null || e === void 0 ? void 0 : e.message,
                agentId,
            });
            return [];
        }
    }
    flushDirty() {
        for (const agentId of this.dirtyAgents) {
            const inbox = this.inboxes.get(agentId);
            if (!inbox)
                continue;
            this.flushAgent(agentId, inbox);
        }
        this.dirtyAgents.clear();
    }
    flushAgent(agentId, inbox) {
        const filePath = path.join(this.baseDir, `${agentId}.ndjson`);
        const tmpPath = filePath + '.tmp';
        try {
            const content = inbox.map((m) => JSON.stringify(m)).join('\n') + '\n';
            fs.writeFileSync(tmpPath, content, 'utf-8');
            fs.renameSync(tmpPath, filePath);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('AgentInbox', 'Failed to flush inbox', {
                error: e === null || e === void 0 ? void 0 : e.message,
                agentId,
            });
        }
    }
}
exports.AgentInbox = AgentInbox;
