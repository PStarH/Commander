import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgresMemoryService } from '../packages/core/src/memory/postgresMemoryService';
import {
  MemoryMigrationRunner,
  type LegacyMemoryRecord,
  type MemoryMigrationCheckpointStore,
  type MemoryMigrationSource,
} from '../packages/core/src/memory/memoryMigration';

interface Arguments {
  source?: string;
  tenant?: string;
  databaseUrl?: string;
  help: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--source') result.source = argv[++index];
    else if (arg === '--tenant') result.tenant = argv[++index];
    else if (arg === '--database-url') result.databaseUrl = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: tsx scripts/migrate-memory-to-postgres.ts --source <json-file> --tenant <tenant-id> --database-url <dsn>',
      '',
      'The source file is read-only. It may contain a JSON array or one JSON record per line.',
    ].join('\n') + '\n',
  );
}

async function loadRecords(sourcePath: string): Promise<LegacyMemoryRecord[]> {
  const text = await readFile(sourcePath, 'utf8');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error('source JSON must be an array');
    return parsed as LegacyMemoryRecord[];
  } catch (error) {
    if (error instanceof SyntaxError) {
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LegacyMemoryRecord);
    }
    throw error;
  }
}

class FileCheckpointStore implements MemoryMigrationCheckpointStore {
  constructor(private readonly path: string) {}

  async load(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { sourceId?: string };
      return parsed.sourceId;
    } catch {
      return undefined;
    }
  }

  async save(_sourceName: string, sourceId: string): Promise<void> {
    await writeFile(this.path, JSON.stringify({ sourceId }) + '\n', 'utf8');
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const sourcePath = args.source ? resolve(args.source) : undefined;
  const databaseUrl =
    args.databaseUrl ?? process.env.COMMANDER_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!sourcePath || !databaseUrl) {
    printHelp();
    throw new Error('--source and --database-url are required');
  }

  const records = await loadRecords(sourcePath);
  const source: MemoryMigrationSource = {
    sourceName: sourcePath,
    async *listRecords() {
      yield* records;
    },
  };
  const service = new PostgresMemoryService({ connectionString: databaseUrl });
  await service.initialize();
  const runner = new MemoryMigrationRunner(
    service,
    source,
    new FileCheckpointStore(`${sourcePath}.memory-migration-checkpoint.json`),
    (record) => record.tenantId ?? args.tenant,
  );
  const result = await runner.run();
  process.stdout.write(JSON.stringify(result) + '\n');
  await service.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
