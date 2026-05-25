#!/usr/bin/env node
/// <reference types="node" />
/**
 * Commander CLI — dev entry point
 *
 * This delegates to the canonical CLI in packages/core/src/cli.ts.
 * For production usage, install @commander/core and run `commander`.
 */
import './packages/core/src/cli';
