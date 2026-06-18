/**
 * Seccomp-BPF Filter Generator for Commander
 *
 * Generates raw BPF bytecode for Linux seccomp filters. Used with bubblewrap's
 * --seccomp FD flag to add syscall-level filtering to the sandbox.
 *
 * Architecture: Pure TypeScript, zero native dependencies.
 * The generated BPF program is a whitelist: only listed syscalls are allowed.
 * All others return SECCOMP_RET_KILL_PROCESS (terminates the sandboxed process).
 *
 * References:
 *   - https://docs.kernel.org/userspace-api/seccomp_filter.html
 *   - https://man7.org/linux/man-pages/man2/seccomp.2.html
 *   - Codex CLI's seccomp integration (codex-rs/sandboxing/src/)
 *   - Claude Code's @anthropic-ai/sandbox-runtime
 *
 * Usage:
 *   const bpf = buildSeccompFilter({ allowNetwork: false });
 *   fs.writeFileSync(tmpFile, bpf);
 *   // Then pass to bwrap: --seccomp 3 with fd 3 = tmpFile
 */
export interface SeccompFilterOptions {
    /** Allow network syscalls (socket, connect, bind, etc.) */
    allowNetwork?: boolean;
    /** Allow process creation (clone, fork, execve) */
    allowProcessCreation?: boolean;
    /** Additional syscall numbers to allow */
    extraAllowed?: number[];
    /** Target architecture (auto-detected if not specified) */
    arch?: 'x86_64' | 'aarch64';
}
/**
 * Build a seccomp-BPF filter program as raw bytes.
 *
 * The filter is a whitelist: only listed syscalls are allowed.
 * All others are killed (SECCOMP_RET_KILL_PROCESS).
 */
export declare function buildSeccompFilter(options?: SeccompFilterOptions): Buffer;
/**
 * Write a seccomp filter to a temp file and return the path.
 * Caller is responsible for cleanup.
 */
export declare function writeSeccompFilterToFile(options?: SeccompFilterOptions): string;
/**
 * Count allowed syscalls in the filter (for logging/debugging).
 */
export declare function countAllowedSyscalls(options?: SeccompFilterOptions): number;
//# sourceMappingURL=seccompBpf.d.ts.map