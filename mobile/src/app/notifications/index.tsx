import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Bell,
  CalendarDays,
  AlertTriangle,
  MessageSquare,
  ShieldCheck,
  CheckCheck,
  ChevronRight,
  Info,
} from 'lucide-react-native';

import { Screen, Card, Chip, SectionTitle } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { SessionStore } from '@/storage/sessionStore';
import {
  NotificationRepository,
  NotificationItem,
} from '@/storage/notificationRepository';

const CATEGORIES = [
  { key: 'ALL', label: 'All' },
  { key: 'ATTENDANCE', label: 'Attendance' },
  { key: 'ALERT', label: 'Alerts' },
  { key: 'REQUEST', label: 'Requests' },
];

// Fallback demonstrable notifications for offline demo mode
const FALLBACK_NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'demo-notif-1',
    recipient_user_id: 'default',
    category: 'ATTENDANCE',
    priority: 'NORMAL',
    title: 'Attendance Finalized',
    message: 'Attendance for CS301 (Data Structures) Period 1 was finalized with 36 present.',
    action_route: '/(faculty)/assignments',
    is_read: false,
    created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: 'demo-notif-2',
    recipient_user_id: 'default',
    category: 'ALERT',
    priority: 'HIGH',
    title: 'Attendance Shortage Alert',
    message: 'Karan Malhotra (21CS036) is currently below 75% attendance threshold (58%).',
    action_route: '/(faculty)/reports',
    is_read: false,
    created_at: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
  },
  {
    id: 'demo-notif-3',
    recipient_user_id: 'default',
    category: 'REQUEST',
    priority: 'NORMAL',
    title: 'Grievance Submitted',
    message: 'Aarav Sharma submitted an attendance correction request for CS301 on 2026-10-31.',
    action_route: '/(student)/(tabs)/requests',
    is_read: true,
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
  },
  {
    id: 'demo-notif-4',
    recipient_user_id: 'default',
    category: 'SYSTEM',
    priority: 'LOW',
    title: 'Biometric Model Ready',
    message: 'EdgeFace-XS (512-D) offline face recognition pipeline initialized successfully.',
    action_route: undefined,
    is_read: true,
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
];

export default function NotificationCenterScreen() {
  const router = useRouter();
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const currentUser = SessionStore.getUser();
  const token = SessionStore.getToken();
  const userId = currentUser?.id || 'default';

  const loadNotifications = useCallback(
    async (showLoadingSpinner: boolean = true) => {
      if (showLoadingSpinner) setLoading(true);
      try {
        const items = await NotificationRepository.fetchAndSyncNotifications(
          userId,
          token,
          selectedCategory
        );
        if (items.length > 0) {
          setNotifications(items);
        } else {
          // If no cached or server notifications, display initial fallback
          const filteredFallback =
            selectedCategory === 'ALL'
              ? FALLBACK_NOTIFICATIONS
              : FALLBACK_NOTIFICATIONS.filter((n) => n.category === selectedCategory);
          setNotifications(filteredFallback);
        }
      } catch (err) {
        setNotifications(FALLBACK_NOTIFICATIONS);
      } finally {
        if (showLoadingSpinner) setLoading(false);
        setRefreshing(false);
      }
    },
    [userId, token, selectedCategory]
  );

  useEffect(() => {
    loadNotifications(true);
  }, [loadNotifications]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadNotifications(false);
  };

  const handleNotificationPress = async (item: NotificationItem) => {
    if (!item.is_read) {
      await NotificationRepository.markAsRead(item.id, token);
      setNotifications((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, is_read: true } : n))
      );
    }

    if (item.action_route) {
      try {
        router.push(item.action_route as any);
      } catch (e) {
        // Fallback if route fails
      }
    }
  };

  const handleMarkAllRead = async () => {
    await NotificationRepository.markAllAsRead(userId, token);
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
  };

  const formatRelativeTime = (isoString: string) => {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  const getCategoryIcon = (category: string, priority: string) => {
    switch (category) {
      case 'ATTENDANCE':
        return <CalendarDays size={18} color={Colors.forest} />;
      case 'ALERT':
        return (
          <AlertTriangle
            size={18}
            color={priority === 'HIGH' || priority === 'URGENT' ? Colors.rose : Colors.amber}
          />
        );
      case 'REQUEST':
        return <MessageSquare size={18} color="#3b82f6" />;
      default:
        return <ShieldCheck size={18} color={Colors.inkSecondary} />;
    }
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <Screen
      title="Notifications"
      subtitle={
        unreadCount > 0 ? `${unreadCount} unread update${unreadCount > 1 ? 's' : ''}` : 'All caught up'
      }
      onBack={() => router.back()}
      right={
        unreadCount > 0 ? (
          <Pressable
            onPress={handleMarkAllRead}
            style={styles.markAllButton}
            accessibilityLabel="Mark all as read"
          >
            <CheckCheck size={16} color={Colors.forest} />
            <Text style={styles.markAllText}>Mark read</Text>
          </Pressable>
        ) : undefined
      }
    >
      {/* Category Filter Pills */}
      <View style={styles.filterRow}>
        {CATEGORIES.map((cat) => {
          const isActive = selectedCategory === cat.key;
          return (
            <Pressable
              key={cat.key}
              style={[styles.filterPill, isActive && styles.filterPillActive]}
              onPress={() => setSelectedCategory(cat.key)}
            >
              <Text
                style={[styles.filterPillText, isActive && styles.filterPillTextActive]}
              >
                {cat.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Notifications List */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={Colors.forest}
          />
        }
      >
        {loading ? (
          <ActivityIndicator color={Colors.forest} style={{ marginTop: 40 }} />
        ) : notifications.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Bell size={44} color={Colors.soft} strokeWidth={1.5} />
            <Text style={styles.emptyTitle}>No Notifications</Text>
            <Text style={styles.emptySubtitle}>
              You have no {selectedCategory !== 'ALL' ? selectedCategory.toLowerCase() : ''} notifications right now.
            </Text>
          </View>
        ) : (
          <View style={styles.notificationsList}>
            {notifications.map((item) => {
              return (
                <Pressable
                  key={item.id}
                  style={[
                    styles.notificationCard,
                    !item.is_read && styles.notificationCardUnread,
                  ]}
                  onPress={() => handleNotificationPress(item)}
                >
                  <View style={styles.iconCircle}>
                    {getCategoryIcon(item.category, item.priority)}
                  </View>

                  <View style={styles.cardContent}>
                    <View style={styles.cardHeaderRow}>
                      <Text
                        style={[
                          styles.notificationTitle,
                          !item.is_read && styles.notificationTitleUnread,
                        ]}
                        numberOfLines={1}
                      >
                        {item.title}
                      </Text>
                      <Text style={styles.timeText}>
                        {formatRelativeTime(item.created_at)}
                      </Text>
                    </View>

                    <Text style={styles.notificationMessage} numberOfLines={3}>
                      {item.message}
                    </Text>

                    <View style={styles.cardFooterRow}>
                      <Chip
                        tone={
                          item.category === 'ATTENDANCE'
                            ? 'sage'
                            : item.category === 'ALERT'
                            ? 'apricot'
                            : 'neutral'
                        }
                      >
                        {item.category}
                      </Chip>

                      {item.action_route && (
                        <View style={styles.viewLinkRow}>
                          <Text style={styles.viewLinkText}>View</Text>
                          <ChevronRight size={12} color={Colors.forest} />
                        </View>
                      )}
                    </View>
                  </View>

                  {!item.is_read && <View style={styles.unreadDot} />}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  filterPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radii.pill,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  filterPillActive: {
    backgroundColor: Colors.forest,
    borderColor: Colors.forest,
  },
  filterPillText: {
    fontSize: 13,
    fontWeight: '500',
    color: Colors.inkSecondary,
  },
  filterPillTextActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  notificationsList: {
    gap: 10,
  },
  notificationCard: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderRadius: Radii.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'flex-start',
    gap: 12,
  },
  notificationCardUnread: {
    borderColor: 'rgba(16, 185, 129, 0.4)',
    backgroundColor: 'rgba(16, 185, 129, 0.02)',
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  cardContent: {
    flex: 1,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  notificationTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
    flex: 1,
    marginRight: 8,
  },
  notificationTitleUnread: {
    fontWeight: '700',
  },
  timeText: {
    fontSize: 11,
    color: Colors.inkTertiary,
  },
  notificationMessage: {
    fontSize: 13,
    color: Colors.inkSecondary,
    lineHeight: 18,
    marginBottom: 8,
  },
  cardFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  viewLinkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  viewLinkText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.forest,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.forest,
    marginTop: 6,
  },
  markAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radii.sm,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
  },
  markAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.forest,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 10,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.ink,
  },
  emptySubtitle: {
    fontSize: 13,
    color: Colors.inkSecondary,
    textAlign: 'center',
    paddingHorizontal: 30,
  },
});
