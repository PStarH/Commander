"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentContext = void 0;
const node_async_hooks_1 = require("node:async_hooks");
exports.agentContext = new node_async_hooks_1.AsyncLocalStorage();
