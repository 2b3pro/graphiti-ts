/**
 * Queue service — port of Python's mcp_server/src/services/queue_service.py.
 *
 * Manages per-group sequential episode processing to prevent race conditions
 * when multiple episodes arrive for the same group concurrently.
 */

type ProcessFunction = () => Promise<void>;

interface QueueEntry {
  process: ProcessFunction;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class QueueService {
  private queues: Map<string, QueueEntry[]> = new Map();
  private workers: Map<string, boolean> = new Map();

  /**
   * Add an episode processing task to the per-group queue.
   * Returns a promise that resolves when the task completes.
   */
  async addTask(groupId: string, processFunc: ProcessFunction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.queues.has(groupId)) {
        this.queues.set(groupId, []);
      }

      this.queues.get(groupId)!.push({ process: processFunc, resolve, reject });

      if (!this.workers.get(groupId)) {
        this.processQueue(groupId);
      }
    });
  }

  /**
   * Add an episode processing task and return the queue position (non-blocking).
   */
  enqueue(groupId: string, processFunc: ProcessFunction): number {
    if (!this.queues.has(groupId)) {
      this.queues.set(groupId, []);
    }

    const entry: QueueEntry = {
      process: processFunc,
      resolve: () => {},
      reject: () => {}
    };

    this.queues.get(groupId)!.push(entry);

    if (!this.workers.get(groupId)) {
      this.processQueue(groupId);
    }

    return this.queues.get(groupId)!.length;
  }

  private async processQueue(groupId: string): Promise<void> {
    this.workers.set(groupId, true);

    try {
      const queue = this.queues.get(groupId);
      if (!queue) return;

      while (queue.length > 0) {
        const entry = queue.shift()!;
        try {
          await entry.process();
          entry.resolve();
        } catch (error) {
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.workers.set(groupId, false);

      // Check if new items were added while processing
      const queue = this.queues.get(groupId);
      if (queue && queue.length > 0) {
        this.processQueue(groupId);
      }
    }
  }

  getQueueSize(groupId: string): number {
    return this.queues.get(groupId)?.length ?? 0;
  }

  isWorkerRunning(groupId: string): boolean {
    return this.workers.get(groupId) ?? false;
  }
}
