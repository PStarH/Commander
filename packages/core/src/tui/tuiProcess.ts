#!/usr/bin/env node
/**
 * TUI Child Process — launched by `commander run --tui`.
 * Runs the blessed terminal dashboard in a separate process.
 * Subscribes to the message bus via the shared checkpoint store.
 */
import { startTUI } from '../tui';
startTUI({ stateDir: process.env.COMMANDER_TUI_STATE_DIR });
