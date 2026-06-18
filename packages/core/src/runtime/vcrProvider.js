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
exports.VCRProvider = void 0;
exports.createVCRProvider = createVCRProvider;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
function hashRequest(request, algo) {
    const canonical = JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        tools: request.tools,
    });
    return crypto.createHash(algo).update(canonical).digest('hex');
}
function messagesMatch(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].role !== b[i].role || a[i].content !== b[i].content)
            return false;
    }
    return true;
}
class VCRProvider {
    constructor(wrapped, config) {
        this.hitCount = 0;
        this.missCount = 0;
        this.name = `vcr:${wrapped.name}`;
        this.wrapped = wrapped;
        this.config = {
            hashAlgorithm: 'sha256',
            matchByContent: true,
            ...config,
        };
        this.cassettePath = path.join(this.config.cassetteDir, `${this.sanitizeName(wrapped.name)}.json`);
        this.cassette = this.loadCassette();
    }
    async call(request) {
        if (this.config.mode === 'replay') {
            const cached = this.findMatch(request);
            if (cached) {
                this.hitCount++;
                return cached.response;
            }
            this.missCount++;
            throw new Error(`VCR: no cassette match for model="${request.model}" (hash=${hashRequest(request, this.config.hashAlgorithm)})`);
        }
        if (this.config.mode === 'record') {
            const response = await this.wrapped.call(request);
            this.recordEntry(request, response);
            return response;
        }
        return this.wrapped.call(request);
    }
    getStats() {
        return {
            hits: this.hitCount,
            misses: this.missCount,
            entries: this.cassette.entries.length,
        };
    }
    getCassette() {
        return { ...this.cassette };
    }
    clearStats() {
        this.hitCount = 0;
        this.missCount = 0;
    }
    findMatch(request) {
        if (this.config.matchByContent) {
            return this.cassette.entries.find((e) => e.request.model === request.model && messagesMatch(e.request.messages, request.messages));
        }
        const hash = hashRequest(request, this.config.hashAlgorithm);
        return this.cassette.entries.find((e) => e.hash === hash);
    }
    recordEntry(request, response) {
        const hash = hashRequest(request, this.config.hashAlgorithm);
        const existing = this.cassette.entries.findIndex((e) => e.hash === hash);
        const entry = {
            request,
            response,
            recordedAt: new Date().toISOString(),
            hash,
        };
        if (existing >= 0) {
            this.cassette.entries[existing] = entry;
        }
        else {
            this.cassette.entries.push(entry);
        }
        this.saveCassette();
    }
    loadCassette() {
        try {
            if (fs.existsSync(this.cassettePath)) {
                const raw = fs.readFileSync(this.cassettePath, 'utf-8');
                return JSON.parse(raw);
            }
        }
        catch {
            // corrupt cassette → start fresh
        }
        return {
            name: this.wrapped.name,
            version: 1,
            recordedAt: new Date().toISOString(),
            entries: [],
        };
    }
    saveCassette() {
        fs.mkdirSync(path.dirname(this.cassettePath), { recursive: true });
        this.cassette.recordedAt = new Date().toISOString();
        fs.writeFileSync(this.cassettePath, JSON.stringify(this.cassette, null, 2));
    }
    sanitizeName(name) {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    }
}
exports.VCRProvider = VCRProvider;
function createVCRProvider(wrapped, cassetteDir, mode = 'replay') {
    return new VCRProvider(wrapped, { cassetteDir, mode });
}
