"use strict";
/**
 * Runtime Configuration Validation
 *
 * Pure TypeScript schema validation for runtime configuration objects.
 * No external dependencies — uses built-in type checking only.
 *
 * Usage:
 *   const schema = createSchema({
 *     port: { type: 'number', required: true, min: 1, max: 65535 },
 *     host: { type: 'string', default: '127.0.0.1' },
 *   });
 *   const result = validateConfig(myConfig, schema);
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSchema = createSchema;
exports.mergeWithDefaults = mergeWithDefaults;
exports.validateConfig = validateConfig;
exports.validateRuntimeConfig = validateRuntimeConfig;
exports.validateHttpServerConfig = validateHttpServerConfig;
exports.validateField = validateField;
// ── Helpers ────────────────────────────────────────────────────────
function resolveNested(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current == null || typeof current !== 'object')
            return null;
        current = current[parts[i]];
    }
    const key = parts[parts.length - 1];
    return {
        parent: current,
        key,
        value: current === null || current === void 0 ? void 0 : current[key],
    };
}
function getTypeName(val) {
    if (val === null)
        return 'string';
    if (Array.isArray(val))
        return 'array';
    return typeof val;
}
function formatError(path, message, value, expected) {
    return { path, message, value, expected };
}
// ── Core Validator ─────────────────────────────────────────────────
/**
 * Create a schema definition for a config type.
 * This is just a typed helper — the schema itself is a plain object.
 */
function createSchema(schema) {
    return schema;
}
/**
 * Merge a partial config with schema defaults.
 * Returns a new object with all default values filled in.
 */
function mergeWithDefaults(partial, schema) {
    const result = {};
    for (const [key, field] of Object.entries(schema)) {
        if (partial[key] !== undefined) {
            result[key] = partial[key];
        }
        else if (field.default !== undefined) {
            result[key] = field.default;
        }
        else if (!field.required) {
            result[key] = field.default;
        }
    }
    return result;
}
/**
 * Validate a config object against a schema.
 * Returns { valid, errors, data } where data is the validated+defaulted config.
 */
function validateConfig(config, schema) {
    const errors = [];
    const data = {};
    const input = config !== null && config !== void 0 ? config : {};
    for (const [key, field] of Object.entries(schema)) {
        const value = input === null || input === void 0 ? void 0 : input[key];
        // Check required
        if (value === undefined || value === null) {
            if (field.required) {
                errors.push(formatError(key, `Field "${key}" is required`, undefined, field.type));
            }
            // Use default if available
            if (field.default !== undefined) {
                data[key] = field.default;
            }
            continue;
        }
        // Type check
        const actualType = getTypeName(value);
        if (field.type === 'enum' && field.enum) {
            if (!field.enum.includes(String(value))) {
                errors.push(formatError(key, `Field "${key}" must be one of: ${field.enum.join(', ')}`, value, field.enum.join('|')));
                data[key] = value;
                continue;
            }
        }
        else if (field.type === 'object' && field.fields) {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                errors.push(formatError(key, `Field "${key}" must be an object`, value, 'object'));
                data[key] = value;
                continue;
            }
            // Recursively validate nested object
            const nestedResult = validateConfig(value, field.fields);
            errors.push(...nestedResult.errors.map((e) => ({
                ...e,
                path: `${key}.${e.path}`,
            })));
            data[key] = nestedResult.data;
            continue;
        }
        else if (actualType !== field.type) {
            // Allow coercion: string→number, number→string
            if (field.type === 'number' && actualType === 'string') {
                const num = Number(value);
                if (isNaN(num)) {
                    errors.push(formatError(key, `Field "${key}" must be a valid number`, value, 'number'));
                    data[key] = value;
                    continue;
                }
                data[key] = num;
                // Continue to constraint checks
                const numVal = num;
                if (field.min !== undefined && numVal < field.min) {
                    errors.push(formatError(key, `Field "${key}" must be >= ${field.min}`, numVal, `>= ${field.min}`));
                }
                if (field.max !== undefined && numVal > field.max) {
                    errors.push(formatError(key, `Field "${key}" must be <= ${field.max}`, numVal, `<= ${field.max}`));
                }
                continue;
            }
            errors.push(formatError(key, `Field "${key}" must be of type ${field.type}`, value, field.type));
            data[key] = value;
            continue;
        }
        // Constraint checks
        if (field.type === 'number') {
            const numVal = value;
            if (field.min !== undefined && numVal < field.min) {
                errors.push(formatError(key, `Field "${key}" must be >= ${field.min}`, numVal, `>= ${field.min}`));
            }
            if (field.max !== undefined && numVal > field.max) {
                errors.push(formatError(key, `Field "${key}" must be <= ${field.max}`, numVal, `<= ${field.max}`));
            }
        }
        if (field.type === 'string') {
            const strVal = String(value);
            if (field.minLength !== undefined && strVal.length < field.minLength) {
                errors.push(formatError(key, `Field "${key}" must be at least ${field.minLength} characters`, strVal, `min ${field.minLength}`));
            }
            if (field.maxLength !== undefined && strVal.length > field.maxLength) {
                errors.push(formatError(key, `Field "${key}" must be at most ${field.maxLength} characters`, strVal, `max ${field.maxLength}`));
            }
        }
        if (field.type === 'array' && Array.isArray(value) && field.min !== undefined) {
            if (value.length < field.min) {
                errors.push(formatError(key, `Field "${key}" must have at least ${field.min} items`, value.length, `>= ${field.min}`));
            }
        }
        data[key] = value;
    }
    // Check for unknown fields
    for (const key of Object.keys(input)) {
        if (!(key in schema)) {
            errors.push(formatError(key, `Unknown field "${key}"`, input[key]));
        }
    }
    return {
        valid: errors.length === 0,
        errors,
        data: data,
    };
}
/**
 * Validate AgentRuntimeConfig against its schema.
 */
function validateRuntimeConfig(config) {
    const schema = createSchema({
        maxStepsPerRun: { type: 'number', required: true, min: 1, max: 1000, default: 50 },
        maxRetries: { type: 'number', required: true, min: 0, max: 10, default: 3 },
        timeoutMs: { type: 'number', required: true, min: 1000, max: 600000, default: 180000 },
        maxConcurrency: { type: 'number', required: true, min: 1, max: 100, default: 10 },
        budgetHardCapTokens: {
            type: 'number',
            required: true,
            min: 1000,
            max: 10000000,
            default: 100000,
        },
        enableCache: { type: 'boolean', default: true },
        enableTracing: { type: 'boolean', default: true },
        logLevel: { type: 'enum', enum: ['debug', 'info', 'warn', 'error'], default: 'info' },
    });
    return validateConfig(config, schema);
}
/**
 * Validate HttpServerConfig against its schema.
 */
function validateHttpServerConfig(config) {
    const schema = createSchema({
        port: { type: 'number', required: true, min: 1, max: 65535, default: 3001 },
        host: { type: 'string', default: '127.0.0.1' },
        cors: { type: 'boolean', default: true },
        corsAllowedOrigins: {
            type: 'array',
            default: ['http://localhost:3000', 'http://127.0.0.1:3000'],
        },
        maxBodyBytes: { type: 'number', min: 1024, max: 100 * 1024 * 1024, default: 1024 * 1024 },
        apiKey: { type: 'string' },
        rateLimitPerMinute: { type: 'number', min: 0, max: 100000, default: 120 },
    });
    return validateConfig(config, schema);
}
/**
 * Validate a single config value against a field definition.
 */
function validateField(value, field, path) {
    const result = validateConfig({ [path.split('.').pop()]: value }, { [path.split('.').pop()]: field });
    return result.errors;
}
