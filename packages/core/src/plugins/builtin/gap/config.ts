// packages/core/src/plugins/builtin/gap/config.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GapConfig {
  repo: string;
  token: string;
  defaultLabels: string[];
  titlePrefix: string;
  dedupEnabled: boolean;
  dryRun: boolean;
  registryFile: string;
}

const DEFAULT_REGISTRY_PATH = '.commander/gaps/registry.ndjson';

export function loadGapConfig(): GapConfig {
  const configPath = path.join(process.cwd(), '.commander', 'gap-config.json');
  let fileConfig: Partial<GapConfig> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<GapConfig>;
  }
  return {
    repo: fileConfig.repo ?? process.env.COMMANDER_GH_REPO ?? '',
    token: fileConfig.token ?? process.env.COMMANDER_GH_TOKEN ?? '',
    defaultLabels: fileConfig.defaultLabels ?? ['gap-discovery'],
    titlePrefix: fileConfig.titlePrefix ?? '[gap]',
    dedupEnabled: fileConfig.dedupEnabled ?? true,
    dryRun: fileConfig.dryRun ?? process.env.COMMANDER_GAP_DRY_RUN === 'true',
    registryFile: fileConfig.registryFile ?? DEFAULT_REGISTRY_PATH,
  };
}
