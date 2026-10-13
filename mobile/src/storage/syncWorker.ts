export interface SyncQueueRow {
  queueId: number;
  clientSessionUuid: string;
  endpointPath: string;
  payloadJson: string;
  syncStatus: 'PENDING' | 'IN_FLIGHT' | 'ACKNOWLEDGED' | 'FAILED';
  retryCount: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncHttpResponse {
  statusCode: number;
  data: any;
}

export type HttpTransportFn = (
  endpointPath: string,
  payload: any,
  token?: string
) => Promise<SyncHttpResponse>;

async function resolveDb(customDb?: any) {
  if (customDb) {
    return {
      async getAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
        if (customDb.getAllAsync) return customDb.getAllAsync(sql, params);
        if (customDb.prepare) return customDb.prepare(sql).all(...params) as T[];
        return [];
      },
      async run(sql: string, params: any[] = []): Promise<void> {
        if (customDb.runAsync) return customDb.runAsync(sql, params);
        if (customDb.prepare) {
          customDb.prepare(sql).run(...params);
          return;
        }
      },
    };
  }

  // Fallback to Expo SQLite database in React Native environment
  const { getDatabase } = await import('./database.ts');
  const db = await getDatabase();
  return {
    async getAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
      return db.getAllAsync(sql, params);
    },
    async run(sql: string, params: any[] = []): Promise<void> {
      await db.runAsync(sql, params);
    },
  };
}

export class AttendanceSyncWorker {
  /**
   * Calculate exponential backoff with jitter.
   * base = 2000 ms, factor = 2, max = 300,000 ms (5 min).
   * jitter = +/- 20%
   */
  static calculateBackoffMs(retryCount: number): number {
    const baseMs = 2000;
    const maxMs = 300000;
    const uncapped = baseMs * Math.pow(2, retryCount);
    const delay = Math.min(maxMs, uncapped);
    const jitterFactor = 0.8 + Math.random() * 0.4; // 0.8 to 1.2
    return Math.round(delay * jitterFactor);
  }

  /**
   * Retrieves pending sync queue items eligible for transmission.
   */
  static async getPendingQueueItems(limit: number = 5, customDb?: any): Promise<SyncQueueRow[]> {
    const db = await resolveDb(customDb);
    const nowIso = new Date().toISOString();

    const rows = await db.getAll<any>(
      `SELECT queue_id, client_session_uuid, endpoint_path, payload_json, sync_status,
              retry_count, last_error, next_retry_at, created_at, updated_at
       FROM sync_queue
       WHERE sync_status = 'PENDING'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY queue_id ASC
       LIMIT ?;`,
      [nowIso, limit]
    );

    return rows.map((r) => ({
      queueId: r.queue_id,
      clientSessionUuid: r.client_session_uuid,
      endpointPath: r.endpoint_path,
      payloadJson: r.payload_json,
      syncStatus: r.sync_status,
      retryCount: r.retry_count,
      lastError: r.last_error,
      nextRetryAt: r.next_retry_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Processes a single sync queue item through the network transport.
   * Transitions queue state: PENDING -> IN_FLIGHT -> ACKNOWLEDGED / FAILED / PENDING (retry).
   */
  static async processQueueItem(
    item: SyncQueueRow,
    transport: HttpTransportFn,
    authToken?: string,
    customDb?: any
  ): Promise<{ success: boolean; status: string; errorMessage?: string }> {
    const db = await resolveDb(customDb);
    const nowIso = new Date().toISOString();

    // 1. Mark IN_FLIGHT
    await db.run(
      "UPDATE sync_queue SET sync_status = 'IN_FLIGHT', updated_at = ? WHERE queue_id = ?;",
      [nowIso, item.queueId]
    );

    let parsedPayload: any;
    try {
      parsedPayload = JSON.parse(item.payloadJson);
    } catch (e: any) {
      await db.run(
        "UPDATE sync_queue SET sync_status = 'FAILED', last_error = ?, updated_at = ? WHERE queue_id = ?;",
        [`Payload JSON parse error: ${e.message}`, nowIso, item.queueId]
      );
      return { success: false, status: 'FAILED', errorMessage: e.message };
    }

    try {
      const response = await transport(item.endpointPath, parsedPayload, authToken);

      // Handle Success (200 / 201)
      if (response.statusCode === 200 || response.statusCode === 201) {
        await db.run(
          "UPDATE local_attendance_sessions SET session_status = 'SYNCED', updated_at = ? WHERE client_session_uuid = ?;",
          [nowIso, item.clientSessionUuid]
        );
        await db.run(
          "UPDATE sync_queue SET sync_status = 'ACKNOWLEDGED', updated_at = ? WHERE client_session_uuid = ?;",
          [nowIso, item.clientSessionUuid]
        );
        return { success: true, status: 'ACKNOWLEDGED' };
      }

      // Handle Unrecoverable Domain Rejections (400, 403, 409)
      if ([400, 403, 409, 422].includes(response.statusCode)) {
        const errorMsg = response.data?.message || `HTTP ${response.statusCode} rejection`;
        await db.run(
          "UPDATE sync_queue SET sync_status = 'FAILED', last_error = ?, updated_at = ? WHERE queue_id = ?;",
          [errorMsg, nowIso, item.queueId]
        );
        return { success: false, status: 'FAILED', errorMessage: errorMsg };
      }

      // Handle Transient Server Errors (5xx, unexpected codes)
      throw new Error(`Server returned transient status code ${response.statusCode}`);
    } catch (error: any) {
      // Transient Network / Server Failure -> Schedule Retry with Backoff
      const nextRetryCount = item.retryCount + 1;
      const backoffMs = AttendanceSyncWorker.calculateBackoffMs(item.retryCount);
      const nextRetryDate = new Date(Date.now() + backoffMs).toISOString();

      await db.run(
        `UPDATE sync_queue
         SET sync_status = 'PENDING',
             retry_count = ?,
             last_error = ?,
             next_retry_at = ?,
             updated_at = ?
         WHERE queue_id = ?;`,
        [nextRetryCount, error.message || 'Network request failed', nextRetryDate, nowIso, item.queueId]
      );

      return {
        success: false,
        status: 'PENDING_RETRY',
        errorMessage: error.message,
      };
    }
  }

  /**
   * Drains all eligible items currently in the sync queue.
   */
  static async drainQueue(
    transport: HttpTransportFn,
    authToken?: string,
    customDb?: any
  ): Promise<{ processed: number; succeeded: number; failed: number; retried: number }> {
    const items = await AttendanceSyncWorker.getPendingQueueItems(10, customDb);
    let succeeded = 0;
    let failed = 0;
    let retried = 0;

    for (const item of items) {
      const res = await AttendanceSyncWorker.processQueueItem(item, transport, authToken, customDb);
      if (res.status === 'ACKNOWLEDGED') succeeded++;
      else if (res.status === 'FAILED') failed++;
      else if (res.status === 'PENDING_RETRY') retried++;
    }

    return {
      processed: items.length,
      succeeded,
      failed,
      retried,
    };
  }
}
