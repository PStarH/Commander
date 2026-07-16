import { describe, expect, it } from 'vitest';
import {
  MemoryServiceValidationError,
  assertForgetTarget,
  assertMemoryScope,
} from '../../src/memory/memoryService';

describe('MemoryService contract validation', () => {
  it('rejects empty tenant and project scope before backend access', () => {
    expect(() => assertMemoryScope({ tenantId: '', projectId: 'project-a' })).toThrow(
      MemoryServiceValidationError,
    );
    expect(() => assertMemoryScope({ tenantId: 'tenant-a', projectId: '   ' })).toThrow(
      MemoryServiceValidationError,
    );
  });

  it('accepts a valid tenant and project scope', () => {
    expect(() => assertMemoryScope({ tenantId: 'tenant-a', projectId: 'project-a' })).not.toThrow();
  });

  it('requires an id or mission id when forgetting memory', () => {
    expect(() =>
      assertForgetTarget({ scope: { tenantId: 'tenant-a', projectId: 'project-a' } }),
    ).toThrow(MemoryServiceValidationError);
    expect(() =>
      assertForgetTarget({
        scope: { tenantId: 'tenant-a', projectId: 'project-a' },
        id: 'memory-1',
      }),
    ).not.toThrow();
    expect(() =>
      assertForgetTarget({
        scope: { tenantId: 'tenant-a', projectId: 'project-a' },
        missionId: 'mission-1',
      }),
    ).not.toThrow();
  });
});
