import { SqliteWorkQueueStore } from '../../../../src/ultimate/sqliteWorkQueueStore';
import { WorkCoordinator } from '../../../../src/ultimate/workCoordinator';

interface T1WorkerResult {
  workerId: string;
  claimed: string[];
  errors: string[];
  durationMs: number;
}

interface T1Request {
  dbPath: string;
  workerId: string;
  targetCount: number;
}

process.on('message', async (req: T1Request) => {
  const t0 = Date.now();
  const result: T1WorkerResult = {
    workerId: req.workerId,
    claimed: [],
    errors: [],
    durationMs: 0,
  };

  try {
    const store = new SqliteWorkQueueStore({ filePath: req.dbPath });
    const coord = new WorkCoordinator({ store });
    const filter = { runId: 'chaos-t1' };

    while (result.claimed.length < req.targetCount) {
      const claimed = coord.claim(`worker-${req.workerId}`, filter);
      if (!claimed) break;
      result.claimed.push(claimed.id);
    }

    store.close();
  } catch (err) {
    result.errors.push((err as Error).message);
  } finally {
    result.durationMs = Date.now() - t0;
    process.send?.(result);
    setTimeout(() => process.exit(0), 50);
  }
});
