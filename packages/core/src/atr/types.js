"use strict";
/**
 * ATR (Agent Transaction Runtime) — shared kernel types.
 *
 * ATR is the runtime that guarantees agent external actions are:
 *   - Idempotent: retries do not duplicate side effects
 *   - Recoverable: failures can be compensated
 *   - Leased: only one process owns a run at a time
 *   - Fenced: zombie processes cannot corrupt in-flight runs
 *
 * This is the kernel for Commander's "Settlement Layer" — it sits between
 * the agent's decision loop and every external system call.
 */
Object.defineProperty(exports, "__esModule", { value: true });
