#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { invokeCommanderToolInputSchema } from './contracts';
import { invokeCommanderTool } from './invoke';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(): Promise<void> {
  const input = invokeCommanderToolInputSchema.parse(JSON.parse(await readStdin()) as unknown);
  const result = await invokeCommanderTool(input);
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
