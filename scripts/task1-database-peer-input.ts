import { createHash } from 'node:crypto';
import {
  TASK1_DATABASE_ROLES,
  createDatabasePeerBindingInput,
  type DatabasePeerBindingInputV1,
  type Task1DatabaseRole,
} from '../packages/kernel/src/canonicalBootstrap.js';

const ROLE_LOGIN: Readonly<Record<Task1DatabaseRole, string>> = {
  'adapter-ops': 'commander_adapter_ops',
  app: 'commander_app',
  owner: 'commander_owner',
  scheduler: 'commander_scheduler',
  'tenant-authority': 'commander_tenant_authority',
  worker: 'commander_worker',
};

function roleEndpoint(
  role: Task1DatabaseRole,
  value: string,
): {
  role: Task1DatabaseRole;
  host: string;
  port: number;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TENANT_CUTOVER_DATABASE_PEER_INPUT_INVALID');
  }
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    decodeURIComponent(url.username) !== ROLE_LOGIN[role] ||
    !url.password ||
    !url.hostname ||
    !url.pathname.slice(1) ||
    url.searchParams.getAll('sslmode').length !== 1 ||
    url.searchParams.get('sslmode') !== 'verify-full'
  ) {
    throw new Error('TENANT_CUTOVER_DATABASE_PEER_INPUT_INVALID');
  }
  const host =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  return { role, host, port: Number(url.port || '5432') };
}

export function createTask1DatabasePeerBindingInput(input: {
  roleUrls: Readonly<Record<Task1DatabaseRole, string>>;
  expectedServerSpkiSha256: string;
  caMountIdentity: string;
  caPath: string;
  caPublicBytes: string | Buffer;
}): DatabasePeerBindingInputV1 {
  try {
    return createDatabasePeerBindingInput({
      roles: TASK1_DATABASE_ROLES.map((role) => roleEndpoint(role, input.roleUrls[role])),
      expectedServerSpkiSha256: input.expectedServerSpkiSha256,
      ca: {
        mountIdentity: input.caMountIdentity,
        path: input.caPath,
        publicBytesSha256: createHash('sha256').update(input.caPublicBytes).digest('hex'),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'TENANT_CUTOVER_DATABASE_PEER_INPUT_INVALID') {
      throw error;
    }
    throw new Error('TENANT_CUTOVER_DATABASE_PEER_INPUT_INVALID');
  }
}
