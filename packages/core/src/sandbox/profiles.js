"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROFILES = exports.HARDENED = exports.FULL_ACCESS = exports.WORKSPACE_WRITE = exports.READ_ONLY = void 0;
exports.READ_ONLY = {
    mode: 'read-only',
    network: 'blocked',
    filesystem: {
        readablePaths: [process.cwd()],
        writablePaths: [],
        protectedPaths: [
            '.git',
            '.commander',
            '.commander_state',
            '.commander_memory',
            '.commander_results',
        ],
        useStagingDir: false,
    },
    envVarDenyList: ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'],
    envVarAllowList: [
        'PATH',
        'HOME',
        'USER',
        'SHELL',
        'TERM',
        'LANG',
        'LC_ALL',
        'TMPDIR',
        'HOSTNAME',
        'PWD',
        'NODE_ENV',
        'PYTHONPATH',
        'XDG_RUNTIME_DIR',
    ],
    timeout: 30000,
};
exports.WORKSPACE_WRITE = {
    mode: 'workspace-write',
    network: 'blocked',
    filesystem: {
        readablePaths: [process.cwd(), '/tmp'],
        writablePaths: [process.cwd(), '/tmp'],
        // FIX: protect .commander_memory and .commander_results (was missing vs READ_ONLY)
        protectedPaths: [
            '.git',
            '.commander',
            '.commander_state',
            '.commander_memory',
            '.commander_results',
        ],
        useStagingDir: false,
    },
    envVarDenyList: ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'],
    // Expanded allow list — common variables needed by build tools and languages
    envVarAllowList: [
        'PATH',
        'HOME',
        'USER',
        'SHELL',
        'TERM',
        'LANG',
        'LC_ALL',
        'TMPDIR',
        'HOSTNAME',
        'PWD',
        'NODE_ENV',
        'PYTHONPATH',
        'XDG_RUNTIME_DIR',
    ],
    timeout: 60000,
};
exports.FULL_ACCESS = {
    mode: 'full-access',
    network: 'full',
    filesystem: {
        readablePaths: ['/'],
        writablePaths: ['/'],
        // Even full-access protects critical system dirs and credential stores
        protectedPaths: [
            '.git',
            '.commander',
            '.commander_state',
            '/etc/shadow',
            '/etc/sudoers',
            '/etc/ssh',
            '.ssh',
            '.gnupg',
            '.aws',
            '.config/gcloud',
            '/root',
            '/var/run/docker.sock',
        ],
        useStagingDir: false,
    },
    envVarDenyList: ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE', 'SIGNATURE'],
    envVarAllowList: ['PATH', 'HOME', 'USER', 'SHELL', 'TERM'],
    timeout: 300000,
};
/**
 * HARDENED — Default-deny network, only LLM API domains allowed via proxy.
 * Recommended for production use. Agent runs in Docker with:
 *   - Read-only root filesystem
 *   - Network: only configured LLM API domains via HTTP CONNECT proxy
 *   - All other network access blocked
 *   - Memory limit: 512MB
 */
exports.HARDENED = {
    mode: 'workspace-write',
    network: 'proxy',
    filesystem: {
        readablePaths: [process.cwd(), '/tmp'],
        writablePaths: [process.cwd(), '/tmp'],
        protectedPaths: [
            '.git',
            '.commander',
            '.commander_state',
            '.commander_memory',
            '.commander_results',
            '/etc/shadow',
            '/etc/sudoers',
            '/etc/ssh',
            '.ssh',
            '.gnupg',
            '.aws',
            '.config/gcloud',
        ],
        useStagingDir: true,
        stagingDir: '/tmp/commander-staging',
    },
    envVarDenyList: ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE', 'SIGNATURE'],
    envVarAllowList: [
        'PATH',
        'HOME',
        'USER',
        'SHELL',
        'TERM',
        'LANG',
        'LC_ALL',
        'TMPDIR',
        'HOSTNAME',
        'PWD',
        'NODE_ENV',
        'PYTHONPATH',
        'XDG_RUNTIME_DIR',
    ],
    timeout: 120000,
    memoryLimitMB: 512,
};
exports.PROFILES = {
    'read-only': exports.READ_ONLY,
    'workspace-write': exports.WORKSPACE_WRITE,
    'full-access': exports.FULL_ACCESS,
    hardened: exports.HARDENED,
};
