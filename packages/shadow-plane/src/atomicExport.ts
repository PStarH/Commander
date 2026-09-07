import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export function atomicExport(outputPath: string, contents: string | Uint8Array): void {
  const parent = dirname(outputPath);
  let parentStats;
  try {
    parentStats = lstatSync(parent);
  } catch {
    throw new Error('SHADOW_EXPORT_PARENT_INVALID');
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error('SHADOW_EXPORT_PARENT_INVALID');
  }
  try {
    if (lstatSync(outputPath).isSymbolicLink()) {
      throw new Error('SHADOW_EXPORT_SYMLINK_FORBIDDEN');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'SHADOW_EXPORT_SYMLINK_FORBIDDEN') throw error;
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  const temporary = join(parent, `.${basename(outputPath)}.${randomBytes(8).toString('hex')}.tmp`);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fileDescriptor, contents);
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporary, outputPath);
    const directoryDescriptor = openSync(parent, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary path may already have been renamed or never created.
    }
    throw error;
  }
}
