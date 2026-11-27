import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbTsContent = readFileSync(join(__dirname, '../database.ts'), 'utf-8');
const match = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(match, 'SCHEMA_SQL should be defined in database.ts');
const schemaSql = match[1];

test('Notification Repository & OTA Lifecycle Local Persistence', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);

  const userId = 'usr-admin-001';

  await t.test('1. Insert and retrieve local OTA update notification', () => {
    const notif = {
      id: 'ota-drop-test-123',
      recipient_user_id: 'system',
      category: 'SYSTEM',
      priority: 'NORMAL',
      title: 'New Update Available',
      message: 'Klasio update test-123 is downloading in the background.',
      payload_json: null,
      action_route: '/(admin)/(tabs)/settings',
      is_read: 0,
      created_at: new Date().toISOString(),
    };

    db.prepare(`
      INSERT INTO cached_notifications (
        id, recipient_user_id, category, priority, title, message,
        payload_json, action_route, is_read, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        message = excluded.message,
        action_route = excluded.action_route;
    `).run(
      notif.id,
      notif.recipient_user_id,
      notif.category,
      notif.priority,
      notif.title,
      notif.message,
      notif.payload_json,
      notif.action_route,
      notif.is_read,
      notif.created_at
    );

    const rows = db.prepare(`
      SELECT * FROM cached_notifications 
      WHERE (recipient_user_id = ? OR recipient_user_id = 'system' OR recipient_user_id = 'default')
      ORDER BY created_at DESC;
    `).all(userId);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'ota-drop-test-123');
    assert.equal(rows[0].category, 'SYSTEM');
    assert.equal(rows[0].title, 'New Update Available');
    assert.equal(rows[0].is_read, 0);
  });

  await t.test('2. Filter notifications by SYSTEM category', () => {
    // Add another non-system notification
    db.prepare(`
      INSERT INTO cached_notifications (
        id, recipient_user_id, category, priority, title, message,
        payload_json, action_route, is_read, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(
      'notif-att-001',
      userId,
      'ATTENDANCE',
      'NORMAL',
      'Attendance Verified',
      'Session recorded successfully.',
      null,
      null,
      0,
      new Date().toISOString()
    );

    const systemRows = db.prepare(`
      SELECT * FROM cached_notifications 
      WHERE (recipient_user_id = ? OR recipient_user_id = 'system' OR recipient_user_id = 'default')
      AND category = 'SYSTEM';
    `).all(userId);

    assert.equal(systemRows.length, 1);
    assert.equal(systemRows[0].category, 'SYSTEM');

    const allRows = db.prepare(`
      SELECT * FROM cached_notifications 
      WHERE (recipient_user_id = ? OR recipient_user_id = 'system' OR recipient_user_id = 'default');
    `).all(userId);

    assert.equal(allRows.length, 2);
  });

  await t.test('3. Unread count includes system notifications', () => {
    const unread = db.prepare(`
      SELECT COUNT(*) as count FROM cached_notifications 
      WHERE (recipient_user_id = ? OR recipient_user_id = 'system' OR recipient_user_id = 'default')
      AND is_read = 0;
    `).get(userId);

    assert.equal(unread.count, 2);
  });

  await t.test('4. Mark all as read clears system and user notifications', () => {
    db.prepare(`
      UPDATE cached_notifications SET is_read = 1 
      WHERE recipient_user_id = ? OR recipient_user_id = 'system' OR recipient_user_id = 'default';
    `).run(userId);

    const unreadAfter = db.prepare(`
      SELECT COUNT(*) as count FROM cached_notifications 
      WHERE (recipient_user_id = ? OR recipient_user_id = 'system' OR recipient_user_id = 'default')
      AND is_read = 0;
    `).get(userId);

    assert.equal(unreadAfter.count, 0);
  });

  await t.test('5. local_key_value table persists OTA lifecycle ID', () => {
    const key = 'last_recorded_applied_ota_id';
    const updateId = 'update-uuid-999';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO local_key_value (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    `).run(key, updateId, now);

    const row = db.prepare(`SELECT value FROM local_key_value WHERE key = ?;`).get(key);
    assert.ok(row);
    assert.equal(row.value, 'update-uuid-999');

    // Update with new ID
    db.prepare(`
      INSERT INTO local_key_value (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    `).run(key, 'update-uuid-1000', new Date().toISOString());

    const updatedRow = db.prepare(`SELECT value FROM local_key_value WHERE key = ?;`).get(key);
    assert.equal(updatedRow.value, 'update-uuid-1000');
  });
});
