'use strict';

/**
 * Shared test setup.
 *
 * Forces an in-memory store, a silent logger and a fixed PRNG seed so every
 * suite starts from the same deterministic plant and nothing writes to disk.
 */

process.env.NODE_ENV = 'test';
process.env.PC_LOG_LEVEL = 'silent';
process.env.PC_STORE = 'memory';
process.env.PC_SEED_ON_BOOT = 'false';
process.env.PC_SIM_ENABLED = 'false';
process.env.PC_MQTT_ENABLED = 'false';
process.env.PC_NODERED_ENABLED = 'false';
process.env.PC_SIM_SEED = '20260916';

// Jest's default handle detection is noisy with timers that are intentionally
// unref'd (snapshots, heartbeats); those never keep the process alive.
jest.setTimeout(30000);
