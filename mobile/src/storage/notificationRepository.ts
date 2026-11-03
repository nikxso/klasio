import { getDatabase } from './database';
import { API_BASE_URL } from '@/config/api';

export interface NotificationItem {
  id: string;
  recipient_user_id: string;
  category: 'ATTENDANCE' | 'ALERT' | 'REQUEST' | 'SYSTEM';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  title: string;
  message: string;
  payload_json?: string | null;
  action_route?: string | null;
  is_read: boolean;
  created_at: string;
}

export class NotificationRepository {
  /**
   * Fetches notifications from backend when online, caches to SQLite,
   * and returns the merged local notifications list.
   */
  static async fetchAndSyncNotifications(
    userId: string,
    token?: string,
    category?: string
  ): Promise<NotificationItem[]> {
    const db = await getDatabase();

    if (token) {
      try {
        const url = new URL(`${API_BASE_URL}/api/v1/notifications`);
        if (category && category !== 'ALL') {
          url.searchParams.set('category', category);
        }

        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (res.ok) {
          const remoteItems: NotificationItem[] = await res.json();
          for (const item of remoteItems) {
            await db.runAsync(
              `INSERT INTO cached_notifications (
                id, recipient_user_id, category, priority, title, message,
                payload_json, action_route, is_read, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                is_read = excluded.is_read,
                title = excluded.title,
                message = excluded.message;`,
              [
                item.id,
                item.recipient_user_id || userId,
                item.category,
                item.priority,
                item.title,
                item.message,
                item.payload_json ? JSON.stringify(item.payload_json) : null,
                item.action_route ?? null,
                item.is_read ? 1 : 0,
                item.created_at,
              ]
            );
          }
        }
      } catch (e) {
        // Network failure; silently fall back to SQLite cache
      }
    }

    return this.listCachedNotifications(userId, category);
  }

  /**
   * Reads cached notifications from SQLite.
   */
  static async listCachedNotifications(
    userId: string,
    category?: string
  ): Promise<NotificationItem[]> {
    const db = await getDatabase();
    let query =
      'SELECT * FROM cached_notifications WHERE recipient_user_id = ?';
    const params: any[] = [userId];

    if (category && category !== 'ALL') {
      query += ' AND category = ?';
      params.push(category);
    }

    query += ' ORDER BY created_at DESC;';

    const rows = await db.getAllAsync<any>(query, params);
    return rows.map((r) => ({
      id: r.id,
      recipient_user_id: r.recipient_user_id,
      category: r.category,
      priority: r.priority,
      title: r.title,
      message: r.message,
      payload_json: r.payload_json,
      action_route: r.action_route,
      is_read: Boolean(r.is_read),
      created_at: r.created_at,
    }));
  }

  /**
   * Retrieves the unread notification count.
   */
  static async getUnreadCount(userId: string, token?: string): Promise<number> {
    if (token) {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/notifications/unread-count`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          return data.unread_count ?? 0;
        }
      } catch (e) {
        // Fall back to SQLite count
      }
    }

    const db = await getDatabase();
    const row = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM cached_notifications WHERE recipient_user_id = ? AND is_read = 0;',
      [userId]
    );
    return row?.count ?? 0;
  }

  /**
   * Marks a specific notification as read.
   */
  static async markAsRead(notificationId: string, token?: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      'UPDATE cached_notifications SET is_read = 1 WHERE id = ?;',
      [notificationId]
    );

    if (token) {
      try {
        await fetch(`${API_BASE_URL}/api/v1/notifications/${notificationId}/read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (e) {}
    }
  }

  /**
   * Marks all notifications for a user as read.
   */
  static async markAllAsRead(userId: string, token?: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      'UPDATE cached_notifications SET is_read = 1 WHERE recipient_user_id = ?;',
      [userId]
    );

    if (token) {
      try {
        await fetch(`${API_BASE_URL}/api/v1/notifications/mark-all-read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (e) {}
    }
  }
}
