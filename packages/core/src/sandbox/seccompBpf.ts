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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ============================================================================
// BPF instruction encoding
// ============================================================================

// BPF instruction classes
const BPF_LD = 0x00;
const BPF_JMP = 0x05;
const BPF_RET = 0x06;

// BPF source/size modifiers
const BPF_W = 0x00; // word (32-bit)
const BPF_K = 0x00; // immediate value (same as BPF_W)
const BPF_ABS = 0x20; // absolute offset from data start

// BPF jump opcodes
const BPF_JEQ = 0x10;

// seccomp return actions
const SECCOMP_RET_KILL_PROCESS = 0x00000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;

// Architecture constants
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;

// seccomp_data layout offsets
const SECCOMP_DATA_NR = 0; // syscall number (uint32)
const SECCOMP_DATA_ARCH = 4; // architecture (uint32)

// ============================================================================
// x86_64 syscall numbers (Linux 6.x)
// ============================================================================

const SYS = {
  // File I/O
  read: 0,
  write: 1,
  open: 2,
  close: 3,
  stat: 4,
  fstat: 5,
  lstat: 6,
  poll: 7,
  lseek: 8,
  mmap: 9,
  mprotect: 10,
  munmap: 11,
  brk: 12,
  ioctl: 16,
  access: 21,
  pipe: 22,
  select: 23,
  sched_yield: 24,
  dup: 32,
  dup2: 33,
  nanosleep: 35,
  getpid: 39,
  clone: 56,
  fork: 57,
  execve: 59,
  exit: 60,
  wait4: 61,
  kill: 62,
  getcwd: 79,
  chdir: 80,
  mkdir: 83,
  rmdir: 84,
  unlink: 87,
  readlink: 89,
  getuid: 102,
  getgid: 104,
  geteuid: 107,
  getegid: 108,
  getppid: 110,
  getpgrp: 111,
  setsid: 112,
  setpgid: 109,
  arch_prctl: 158,
  futex: 202,
  set_tid_address: 218,
  clock_gettime: 228,
  exit_group: 231,
  epoll_wait: 232,
  epoll_ctl: 233,
  tgkill: 234,
  openat: 257,
  mkdirat: 258,
  newfstatat: 262,
  unlinkat: 263,
  readlinkat: 267,
  getrandom: 318,
  pipe2: 293,
  dup3: 292,
  pread64: 17,
  pwrite64: 18,
  readv: 19,
  writev: 20,
  fcntl: 72,
  fadvise64: 221,
  getdents64: 217,
  rt_sigaction: 13,
  rt_sigprocmask: 14,
  rt_sigreturn: 15,
  gettid: 186,
  set_robust_list: 273,
  get_robust_list: 274,
  mremap: 25,
  madvise: 28,
  msync: 26,
  prlimit64: 302,
  getrusage: 98,
  times: 100,

  // Network (conditional)
  socket: 41,
  connect: 42,
  bind: 49,
  listen: 50,
  accept4: 288,
  sendto: 44,
  recvfrom: 45,
  setsockopt: 54,
  getsockopt: 55,
  shutdown: 48,
  getsockname: 51,
  getpeername: 52,
  sendmsg: 46,
  recvmsg: 47,

  // aarch64 has different numbers — we detect at runtime
} as const;

// aarch64 syscall numbers differ; key mappings
const SYS_AARCH64 = {
  read: 63,
  write: 64,
  close: 57,
  fstat: 80,
  mmap: 222,
  mprotect: 226,
  munmap: 215,
  brk: 214,
  ioctl: 29,
  access: 2064,
  pipe2: 594,
  select: 65,
  sched_yield: 124,
  dup: 23,
  dup2: 23,
  nanosleep: 101,
  getpid: 172,
  clone: 220,
  fork: 220,
  execve: 221,
  exit: 93,
  wait4: 260,
  kill: 129,
  getcwd: 17,
  chdir: 49,
  mkdir: 34,
  rmdir: 35,
  unlink: 35,
  readlink: 78,
  getuid: 174,
  getgid: 176,
  geteuid: 175,
  getegid: 177,
  getppid: 173,
  setsid: 157,
  arch_prctl: 0xffffffff, // not on aarch64
  futex: 98,
  set_tid_address: 96,
  clock_gettime: 113,
  exit_group: 94,
  epoll_wait: 22,
  epoll_ctl: 21,
  tgkill: 131,
  openat: 56,
  mkdirat: 34,
  newfstatat: 79,
  unlinkat: 35,
  readlinkat: 78,
  getrandom: 278,
  dup3: 24,
  rt_sigaction: 134,
  rt_sigprocmask: 135,
  rt_sigreturn: 139,
  gettid: 178,
  set_robust_list: 99,
  get_robust_list: 100,
  mremap: 216,
  madvise: 233,
  prlimit64: 261,
  getrusage: 165,
  times: 153,
  socket: 198,
  connect: 203,
  bind: 200,
  listen: 201,
  accept4: 242,
  sendto: 206,
  recvfrom: 207,
  setsockopt: 208,
  getsockopt: 209,
  shutdown: 210,
  getsockname: 204,
  getpeername: 205,
  sendmsg: 211,
  recvmsg: 212,
} as const;

// ============================================================================
// BPF instruction builder
// ============================================================================

interface BpfInstruction {
  code: number;
  jt: number; // jump if true
  jf: number; // jump if false
  k: number; // generic field
}

function bpfStmt(code: number, k: number): BpfInstruction {
  return { code, jt: 0, jf: 0, k };
}

function bpfJump(code: number, k: number, jt: number, jf: number): BpfInstruction {
  return { code, jt, jf, k };
}

function encodeInstructions(instructions: BpfInstruction[]): Buffer {
  const buf = Buffer.alloc(instructions.length * 8);
  for (let i = 0; i < instructions.length; i++) {
    const offset = i * 8;
    const inst = instructions[i];
    buf.writeUInt16LE(inst.code, offset);
    buf.writeUInt8(inst.jt, offset + 2);
    buf.writeUInt8(inst.jf, offset + 3);
    buf.writeUInt32LE(inst.k, offset + 4);
  }
  return buf;
}

// ============================================================================
// Filter builder
// ============================================================================

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

function detectArch(): 'x86_64' | 'aarch64' {
  const platform = os.arch();
  if (platform === 'arm64') return 'aarch64';
  return 'x86_64';
}

function getSyscallNumbers(arch: 'x86_64' | 'aarch64'): typeof SYS {
  return arch === 'aarch64' ? (SYS_AARCH64 as unknown as typeof SYS) : SYS;
}

/**
 * Build a seccomp-BPF filter program as raw bytes.
 *
 * The filter is a whitelist: only listed syscalls are allowed.
 * All others are killed (SECCOMP_RET_KILL_PROCESS).
 */
export function buildSeccompFilter(options: SeccompFilterOptions = {}): Buffer {
  const arch = options.arch ?? detectArch();
  const sys = getSyscallNumbers(arch);
  const archConst = arch === 'aarch64' ? AUDIT_ARCH_AARCH64 : AUDIT_ARCH_X86_64;

  // Build the allowed syscall whitelist
  const allowed = new Set<number>();

  // Helper to safely add syscall numbers
  const addSyscall = (name: string) => {
    const val = (sys as Record<string, number>)[name];
    if (val !== undefined && val < 0x7fffffff) allowed.add(val);
  };

  // Core I/O
  for (const name of [
    'read',
    'write',
    'close',
    'lseek',
    'pread64',
    'pwrite64',
    'readv',
    'writev',
    'ioctl',
    'fcntl',
    'access',
    'fstat',
    'stat',
    'lstat',
    'newfstatat',
    'readlink',
    'readlinkat',
    'getdents64',
    'open',
    'openat',
    'poll',
    'select',
    'dup',
    'dup2',
    'dup3',
    'pipe',
    'pipe2',
    'mmap',
    'munmap',
    'mprotect',
    'mremap',
    'madvise',
    'brk',
    'msync',
    'fadvise64',
  ]) {
    addSyscall(name);
  }

  // Process management
  for (const name of [
    'exit',
    'exit_group',
    'getpid',
    'getppid',
    'gettid',
    'getuid',
    'getgid',
    'geteuid',
    'getegid',
    'getpgrp',
    'wait4',
    'getrusage',
    'times',
    'setsid',
    'setpgid',
    'getcwd',
    'chdir',
    'set_tid_address',
    'set_robust_list',
    'get_robust_list',
    'arch_prctl',
    'futex',
    'sched_yield',
    'rt_sigaction',
    'rt_sigprocmask',
    'rt_sigreturn',
    'prlimit64',
    'getrandom',
    'nanosleep',
    'clock_gettime',
    'tgkill',
    'kill',
  ]) {
    addSyscall(name);
  }

  // Network (conditional)
  if (options.allowNetwork) {
    for (const name of [
      'socket',
      'connect',
      'bind',
      'listen',
      'accept4',
      'sendto',
      'recvfrom',
      'sendmsg',
      'recvmsg',
      'setsockopt',
      'getsockopt',
      'shutdown',
      'getsockname',
      'getpeername',
    ]) {
      addSyscall(name);
    }
  }

  // Process creation (conditional — most sandboxes should allow this)
  if (options.allowProcessCreation !== false) {
    for (const name of ['clone', 'fork', 'execve']) {
      addSyscall(name);
    }
  }

  // Filesystem operations (needed for most tools)
  for (const name of ['mkdir', 'mkdirat', 'rmdir', 'unlink', 'unlinkat']) {
    addSyscall(name);
  }

  // Extra allowed syscalls
  if (options.extraAllowed) {
    for (const nr of options.extraAllowed) allowed.add(nr);
  }

  // Build BPF program
  const instructions: BpfInstruction[] = [];

  // Step 1: Architecture check
  // LD arch (offset 4), JEQ to arch constant → continue, else KILL
  instructions.push(bpfStmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARCH));
  instructions.push(bpfJump(BPF_JMP | BPF_JEQ | BPF_K, archConst, 1, 0));
  instructions.push(bpfStmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));

  // Step 2: Load syscall number
  instructions.push(bpfStmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR));

  // Step 3: Whitelist check — for each allowed syscall, JEQ → ALLOW, else → next
  const allowedArr = Array.from(allowed).sort((a, b) => a - b);
  for (let i = 0; i < allowedArr.length; i++) {
    instructions.push(bpfJump(BPF_JMP | BPF_JEQ | BPF_K, allowedArr[i], 0, 1));
    instructions.push(bpfStmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    // The fall-through checks the next syscall; after the last, it hits the default KILL
  }

  // Step 4: Default — kill the process
  instructions.push(bpfStmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));

  return encodeInstructions(instructions);
}

/**
 * Write a seccomp filter to a temp file and return the path.
 * Caller is responsible for cleanup.
 */
export function writeSeccompFilterToFile(options: SeccompFilterOptions = {}): string {
  const bpf = buildSeccompFilter(options);
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(
    tmpDir,
    `.cmd-seccomp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bpf`,
  );
  fs.writeFileSync(tmpFile, bpf);
  return tmpFile;
}

/**
 * Count allowed syscalls in the filter (for logging/debugging).
 */
export function countAllowedSyscalls(options: SeccompFilterOptions = {}): number {
  const arch = options.arch ?? detectArch();
  const sys = getSyscallNumbers(arch);
  let count = 0;
  const counted = new Set<number>();

  const addIfValid = (name: string) => {
    const val = (sys as Record<string, number>)[name];
    if (val !== undefined && val < 0x7fffffff && !counted.has(val)) {
      counted.add(val);
      count++;
    }
  };

  // Same whitelist as buildSeccompFilter
  for (const name of [
    'read',
    'write',
    'close',
    'lseek',
    'pread64',
    'pwrite64',
    'readv',
    'writev',
    'ioctl',
    'fcntl',
    'access',
    'fstat',
    'stat',
    'lstat',
    'newfstatat',
    'readlink',
    'readlinkat',
    'getdents64',
    'open',
    'openat',
    'poll',
    'select',
    'dup',
    'dup2',
    'dup3',
    'pipe',
    'pipe2',
    'mmap',
    'munmap',
    'mprotect',
    'mremap',
    'madvise',
    'brk',
    'msync',
  ]) {
    addIfValid(name);
  }
  for (const name of [
    'exit',
    'exit_group',
    'getpid',
    'getppid',
    'gettid',
    'getuid',
    'getgid',
    'geteuid',
    'getegid',
    'wait4',
    'getrusage',
    'times',
    'setsid',
    'getcwd',
    'chdir',
    'set_tid_address',
    'set_robust_list',
    'arch_prctl',
    'futex',
    'sched_yield',
    'rt_sigaction',
    'rt_sigprocmask',
    'rt_sigreturn',
    'prlimit64',
    'getrandom',
    'nanosleep',
    'clock_gettime',
    'tgkill',
    'kill',
  ]) {
    addIfValid(name);
  }
  if (options.allowProcessCreation !== false) {
    for (const name of ['clone', 'fork', 'execve']) addIfValid(name);
  }
  for (const name of ['mkdir', 'mkdirat', 'rmdir', 'unlink', 'unlinkat']) addIfValid(name);

  return count;
}
