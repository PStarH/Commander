"use strict";
// ============================================================================
// MCP (Model Context Protocol) — Lightweight TypeScript Implementation
// JSON-RPC 2.0 based protocol for agent↔tool communication
// Spec: https://spec.modelcontextprotocol.io
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_ERROR_CODES = void 0;
exports.MCP_ERROR_CODES = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
};
