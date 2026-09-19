import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export function atomicExport(outputPath: string, contents: string | Uint8Array): void {
  // Resolve the parent instead of rejecting symlinked parents: on macOS `/tmp`
  // and `/var` are symlinks, and mounted volumes routinely appear as symlinks
  // inside containers, so `--output /tmp/report.json` was a false failure. The
  // write target itself is still protected by O_NOFOLLOW plus the explicit
  // symlink check below; only the (operator-chosen) directory is resolved.
  let parent: string;
  try {
    parent = realpathSync(dirname(outputPath));
  } catch {
    throw new Error('SHADOW_EXPORT_PARENT_INVALID');
  }
  if (!lstatSync(parent).isDirectory()) {
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
