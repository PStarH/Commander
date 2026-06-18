export interface WorkerPoolOptions {
  maxConcurrency: number;
}

export interface PoolTask<T> {
  id: string;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

export class WorkerPool {
  private active = 0;
  private readonly queue: PoolTask<unknown>[] = [];
  private closed = false;

  constructor(private readonly options: WorkerPoolOptions) {
    if (options.maxConcurrency < 1) {
      throw new WorkerPoolError('maxConcurrency must be >= 1');
    }
  }

  get maxConcurrency(): number {
    return this.options.maxConcurrency;
  }

  get activeCount(): number {
    return this.active;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new WorkerPoolError('Pool is closed');
    }
    return new Promise<T>((resolve, reject) => {
      const task: PoolTask<T> = { id, fn, resolve, reject };
      this.queue.push(task as PoolTask<unknown>);
      this.drain();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const err = new WorkerPoolError('Pool closed');
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.reject(err);
    }
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue[0];
      if (this.active >= this.options.maxConcurrency) return;
      this.queue.shift();
      this.executeTask(task);
    }
  }

  private async executeTask<T>(task: PoolTask<T>): Promise<void> {
    this.active++;
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.active--;
      this.drain();
    }
  }
}

export class WorkerPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerPoolError';
  }
}

export class InProcessWorkerPool extends WorkerPool {
  constructor(maxConcurrency: number) {
    super({ maxConcurrency });
  }
}
