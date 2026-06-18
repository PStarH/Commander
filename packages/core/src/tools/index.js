"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckpointResourceTool = exports.CodeResourceTool = exports.BrowserResourceTool = exports.WebResourceTool = exports.MemoryResourceTool = exports.FileResourceTool = exports.HandoffCheckTool = exports.HandoffTool = exports.CheckpointCollapseTool = exports.CheckpointListTool = exports.CheckpointRewindTool = exports.CheckpointSaveTool = exports.createRequestToolTool = exports.createRequestHumanInputTool = exports.TOOL_CATEGORIES = exports.ToolRegistry = exports.SearchConversationsTool = exports.SkillViewTool = exports.CodeFixerTool = exports.AnswerFormatTool = exports.CodeRefinerTool = exports.ApplyPatchTool = exports.CodeSearchTool = exports.VerificationTool = exports.ScreenshotCaptureTool = exports.PdfExtractTool = exports.VisionAnalyzeTool = exports.ExecuteScriptTool = exports.findMatchingMetaSpec = exports.getBuiltinMetaSpecs = exports.MetaTool = exports.A2ADelegateTool = exports.AgentTool = exports.BrowserFetchTool = exports.BrowserSearchTool = exports.GitTool = exports.MemoryListTool = exports.MemoryRecallTool = exports.MemoryStoreTool = exports.ShellExecuteTool = exports.PythonExecuteTool = exports.FileHashEditTool = exports.GlobTool = exports.FileListTool = exports.FileSearchTool = exports.FileEditTool = exports.FileWriteTool = exports.FileReadTool = exports.WebFetchTool = exports.WebSearchTool = void 0;
exports._CodeFixerTool = exports._CodeRefinerTool = exports._ExecuteScriptTool = exports.wireResourceToolDependencies = exports.createResourceTools = exports.SystemResourceTool = exports.MediaResourceTool = exports.ExecResourceTool = exports.HandoffResourceTool = void 0;
exports.createAllTools = createAllTools;
exports.buildToolExecutorMap = buildToolExecutorMap;
var webSearchTool_1 = require("./webSearchTool");
Object.defineProperty(exports, "WebSearchTool", { enumerable: true, get: function () { return webSearchTool_1.WebSearchTool; } });
Object.defineProperty(exports, "WebFetchTool", { enumerable: true, get: function () { return webSearchTool_1.WebFetchTool; } });
var fileSystemTool_1 = require("./fileSystemTool");
Object.defineProperty(exports, "FileReadTool", { enumerable: true, get: function () { return fileSystemTool_1.FileReadTool; } });
Object.defineProperty(exports, "FileWriteTool", { enumerable: true, get: function () { return fileSystemTool_1.FileWriteTool; } });
Object.defineProperty(exports, "FileEditTool", { enumerable: true, get: function () { return fileSystemTool_1.FileEditTool; } });
Object.defineProperty(exports, "FileSearchTool", { enumerable: true, get: function () { return fileSystemTool_1.FileSearchTool; } });
Object.defineProperty(exports, "FileListTool", { enumerable: true, get: function () { return fileSystemTool_1.FileListTool; } });
Object.defineProperty(exports, "GlobTool", { enumerable: true, get: function () { return fileSystemTool_1.GlobTool; } });
var fileHashEditTool_1 = require("./fileHashEditTool");
Object.defineProperty(exports, "FileHashEditTool", { enumerable: true, get: function () { return fileHashEditTool_1.FileHashEditTool; } });
var codeExecutionTool_1 = require("./codeExecutionTool");
Object.defineProperty(exports, "PythonExecuteTool", { enumerable: true, get: function () { return codeExecutionTool_1.PythonExecuteTool; } });
Object.defineProperty(exports, "ShellExecuteTool", { enumerable: true, get: function () { return codeExecutionTool_1.ShellExecuteTool; } });
var persistenceTool_1 = require("./persistenceTool");
Object.defineProperty(exports, "MemoryStoreTool", { enumerable: true, get: function () { return persistenceTool_1.MemoryStoreTool; } });
Object.defineProperty(exports, "MemoryRecallTool", { enumerable: true, get: function () { return persistenceTool_1.MemoryRecallTool; } });
Object.defineProperty(exports, "MemoryListTool", { enumerable: true, get: function () { return persistenceTool_1.MemoryListTool; } });
var gitTool_1 = require("./gitTool");
Object.defineProperty(exports, "GitTool", { enumerable: true, get: function () { return gitTool_1.GitTool; } });
var browserTool_1 = require("./browserTool");
Object.defineProperty(exports, "BrowserSearchTool", { enumerable: true, get: function () { return browserTool_1.BrowserSearchTool; } });
Object.defineProperty(exports, "BrowserFetchTool", { enumerable: true, get: function () { return browserTool_1.BrowserFetchTool; } });
var agentTool_1 = require("./agentTool");
Object.defineProperty(exports, "AgentTool", { enumerable: true, get: function () { return agentTool_1.AgentTool; } });
var a2aDelegateTool_1 = require("./a2aDelegateTool");
Object.defineProperty(exports, "A2ADelegateTool", { enumerable: true, get: function () { return a2aDelegateTool_1.A2ADelegateTool; } });
var metaTool_1 = require("./metaTool");
Object.defineProperty(exports, "MetaTool", { enumerable: true, get: function () { return metaTool_1.MetaTool; } });
Object.defineProperty(exports, "getBuiltinMetaSpecs", { enumerable: true, get: function () { return metaTool_1.getBuiltinMetaSpecs; } });
Object.defineProperty(exports, "findMatchingMetaSpec", { enumerable: true, get: function () { return metaTool_1.findMatchingMetaSpec; } });
var scriptTool_1 = require("./scriptTool");
Object.defineProperty(exports, "ExecuteScriptTool", { enumerable: true, get: function () { return scriptTool_1.ExecuteScriptTool; } });
var visionTool_1 = require("./multimodal/visionTool");
Object.defineProperty(exports, "VisionAnalyzeTool", { enumerable: true, get: function () { return visionTool_1.VisionAnalyzeTool; } });
var pdfTool_1 = require("./multimodal/pdfTool");
Object.defineProperty(exports, "PdfExtractTool", { enumerable: true, get: function () { return pdfTool_1.PdfExtractTool; } });
var screenshotTool_1 = require("./multimodal/screenshotTool");
Object.defineProperty(exports, "ScreenshotCaptureTool", { enumerable: true, get: function () { return screenshotTool_1.ScreenshotCaptureTool; } });
var verificationTool_1 = require("./verificationTool");
Object.defineProperty(exports, "VerificationTool", { enumerable: true, get: function () { return verificationTool_1.VerificationTool; } });
var codeSearchTool_1 = require("./codeSearchTool");
Object.defineProperty(exports, "CodeSearchTool", { enumerable: true, get: function () { return codeSearchTool_1.CodeSearchTool; } });
var patchTool_1 = require("./patchTool");
Object.defineProperty(exports, "ApplyPatchTool", { enumerable: true, get: function () { return patchTool_1.ApplyPatchTool; } });
var codeRefinerTool_1 = require("./codeRefinerTool");
Object.defineProperty(exports, "CodeRefinerTool", { enumerable: true, get: function () { return codeRefinerTool_1.CodeRefinerTool; } });
var answerFormatTool_1 = require("./answerFormatTool");
Object.defineProperty(exports, "AnswerFormatTool", { enumerable: true, get: function () { return answerFormatTool_1.AnswerFormatTool; } });
var codeFixer_1 = require("./codeFixer");
Object.defineProperty(exports, "CodeFixerTool", { enumerable: true, get: function () { return codeFixer_1.CodeFixerTool; } });
var skillViewTool_1 = require("../skills/skillViewTool");
Object.defineProperty(exports, "SkillViewTool", { enumerable: true, get: function () { return skillViewTool_1.SkillViewTool; } });
var conversationSearchTool_1 = require("./conversationSearchTool");
Object.defineProperty(exports, "SearchConversationsTool", { enumerable: true, get: function () { return conversationSearchTool_1.SearchConversationsTool; } });
var toolRegistry_1 = require("./toolRegistry");
Object.defineProperty(exports, "ToolRegistry", { enumerable: true, get: function () { return toolRegistry_1.ToolRegistry; } });
Object.defineProperty(exports, "TOOL_CATEGORIES", { enumerable: true, get: function () { return toolRegistry_1.TOOL_CATEGORIES; } });
var requestHumanInputTool_1 = require("./requestHumanInputTool");
Object.defineProperty(exports, "createRequestHumanInputTool", { enumerable: true, get: function () { return requestHumanInputTool_1.createRequestHumanInputTool; } });
var requestToolTool_1 = require("./requestToolTool");
Object.defineProperty(exports, "createRequestToolTool", { enumerable: true, get: function () { return requestToolTool_1.createRequestToolTool; } });
var checkpointTool_1 = require("./checkpointTool");
Object.defineProperty(exports, "CheckpointSaveTool", { enumerable: true, get: function () { return checkpointTool_1.CheckpointSaveTool; } });
Object.defineProperty(exports, "CheckpointRewindTool", { enumerable: true, get: function () { return checkpointTool_1.CheckpointRewindTool; } });
Object.defineProperty(exports, "CheckpointListTool", { enumerable: true, get: function () { return checkpointTool_1.CheckpointListTool; } });
Object.defineProperty(exports, "CheckpointCollapseTool", { enumerable: true, get: function () { return checkpointTool_1.CheckpointCollapseTool; } });
var handoffTool_1 = require("./handoffTool");
Object.defineProperty(exports, "HandoffTool", { enumerable: true, get: function () { return handoffTool_1.HandoffTool; } });
Object.defineProperty(exports, "HandoffCheckTool", { enumerable: true, get: function () { return handoffTool_1.HandoffCheckTool; } });
// STRAP-consolidated resource tools (Single Tool Resource Action Pattern)
var resourceTools_1 = require("./resourceTools");
Object.defineProperty(exports, "FileResourceTool", { enumerable: true, get: function () { return resourceTools_1.FileResourceTool; } });
Object.defineProperty(exports, "MemoryResourceTool", { enumerable: true, get: function () { return resourceTools_1.MemoryResourceTool; } });
Object.defineProperty(exports, "WebResourceTool", { enumerable: true, get: function () { return resourceTools_1.WebResourceTool; } });
Object.defineProperty(exports, "BrowserResourceTool", { enumerable: true, get: function () { return resourceTools_1.BrowserResourceTool; } });
Object.defineProperty(exports, "CodeResourceTool", { enumerable: true, get: function () { return resourceTools_1.CodeResourceTool; } });
Object.defineProperty(exports, "CheckpointResourceTool", { enumerable: true, get: function () { return resourceTools_1.CheckpointResourceTool; } });
Object.defineProperty(exports, "HandoffResourceTool", { enumerable: true, get: function () { return resourceTools_1.HandoffResourceTool; } });
Object.defineProperty(exports, "ExecResourceTool", { enumerable: true, get: function () { return resourceTools_1.ExecResourceTool; } });
Object.defineProperty(exports, "MediaResourceTool", { enumerable: true, get: function () { return resourceTools_1.MediaResourceTool; } });
Object.defineProperty(exports, "SystemResourceTool", { enumerable: true, get: function () { return resourceTools_1.SystemResourceTool; } });
Object.defineProperty(exports, "createResourceTools", { enumerable: true, get: function () { return resourceTools_1.createResourceTools; } });
Object.defineProperty(exports, "wireResourceToolDependencies", { enumerable: true, get: function () { return resourceTools_1.wireResourceToolDependencies; } });
const gitTool_2 = require("./gitTool");
const metaTool_2 = require("./metaTool");
const scriptTool_2 = require("./scriptTool");
Object.defineProperty(exports, "_ExecuteScriptTool", { enumerable: true, get: function () { return scriptTool_2.ExecuteScriptTool; } });
const verificationTool_2 = require("./verificationTool");
const patchTool_2 = require("./patchTool");
const codeRefinerTool_2 = require("./codeRefinerTool");
Object.defineProperty(exports, "_CodeRefinerTool", { enumerable: true, get: function () { return codeRefinerTool_2.CodeRefinerTool; } });
const answerFormatTool_2 = require("./answerFormatTool");
const codeFixer_2 = require("./codeFixer");
Object.defineProperty(exports, "_CodeFixerTool", { enumerable: true, get: function () { return codeFixer_2.CodeFixerTool; } });
const skillViewTool_2 = require("../skills/skillViewTool");
const conversationSearchTool_2 = require("./conversationSearchTool");
const resourceTools_2 = require("./resourceTools");
const fileHashEditTool_2 = require("./fileHashEditTool");
/**
 * Create the full set of tools exposed to the LLM.
 *
 * STRAP consolidation: only domain-level resource tools are registered for
 * filesystem, memory, web, browser, code, checkpoint, handoff, execution,
 * media, and system operations. The legacy granular CRUD tools are still
 * exported and can be instantiated directly, but they are no longer exposed
 * to the model to avoid the 10–30 tool degradation cliff.
 */
function createAllTools(options) {
    const tools = new Map();
    const instances = [
        // STRAP-consolidated resource tools
        ['file', new resourceTools_2.FileResourceTool()],
        ['memory', new resourceTools_2.MemoryResourceTool()],
        ['web', new resourceTools_2.WebResourceTool()],
        ['browser', new resourceTools_2.BrowserResourceTool()],
        ['code', new resourceTools_2.CodeResourceTool()],
        ['checkpoint', new resourceTools_2.CheckpointResourceTool()],
        ['handoff', new resourceTools_2.HandoffResourceTool()],
        ['exec', new resourceTools_2.ExecResourceTool()],
        ['media', new resourceTools_2.MediaResourceTool()],
        ['system', new resourceTools_2.SystemResourceTool()],
        // Single-domain tools that are already consolidated
        ['git', new gitTool_2.GitTool()],
        ['verify', new verificationTool_2.VerificationTool()],
        ['apply_patch', new patchTool_2.ApplyPatchTool()],
        ['file_hash_edit', new fileHashEditTool_2.FileHashEditTool()],
        ['verify_answer', new answerFormatTool_2.AnswerFormatTool()],
        ['skill_view', new skillViewTool_2.SkillViewTool()],
        ['search_conversations', new conversationSearchTool_2.SearchConversationsTool()],
    ];
    for (const [name, tool] of instances) {
        tools.set(name, tool);
    }
    if (options === null || options === void 0 ? void 0 : options.enableMetaTools) {
        const subToolMap = new Map();
        for (const [name, tool] of tools) {
            subToolMap.set(name, (args) => Promise.resolve(tool.execute(args)).then(String));
        }
        for (const spec of (0, metaTool_2.getBuiltinMetaSpecs)()) {
            const name = spec.name;
            const metaTool = new metaTool_2.MetaTool(spec, subToolMap);
            tools.set(name, metaTool);
        }
    }
    return tools;
}
/**
 * Build a map of tool executor functions from a tool map.
 * Useful for wiring programmatic tool callers (e.g., exec.script).
 */
function buildToolExecutorMap(tools) {
    const map = new Map();
    for (const [name, tool] of tools) {
        map.set(name, (args) => Promise.resolve(tool.execute(args)).then(String));
    }
    return map;
}
