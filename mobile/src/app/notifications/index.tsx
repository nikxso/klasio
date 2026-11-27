import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Alert,
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
  Sparkles,
} from 'lucide-react-native';

import { Screen, Card, Chip, SectionTitle } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { SessionStore } from '@/storage/sessionStore';
import {
  NotificationRepository,
  NotificationItem,
} from '@/storage/notificationRepository';
import {
  isPendingUpdateAvailable,
  applyUpdateAndReload,
} from '@/services/updateService';

const CATEGORIES = [
  { key: 'ALL', label: 'All' },
  { key: 'SYSTEM', label: 'Updates' },
  { key: 'ATTENDANCE', label: 'Attendance' },
  { key: 'ALERT', label: 'Alerts' },
  { key: 'REQUEST', label: 'Requests' },
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
        setNotifications(items);
      } catch (err) {
        setNotifications([]);
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

  const resolveSafeActionRoute = (item: NotificationItem): string | null => {
    const user = SessionStore.getUser();
    const role = user?.role?.toUpperCase();
    const route = item.action_route;

    // 1. System / OTA Updates
    if (
      item.category === 'SYSTEM' ||
      item.id?.startsWith('ota-') ||
      route?.includes('settings') ||
      route?.includes('updates')
    ) {
      if (role === 'STUDENT') return '/(student)/(tabs)/profile';
      if (role === 'FACULTY') return '/(faculty)/(tabs)/profile';
      if (!SessionStore.canManageSettings()) return '/(faculty)/(tabs)/profile';
      return '/(admin)/(tabs)/settings';
    }

    // 2. Attendance Requests / Grievances (e.g. /requests/{id})
    if (
      item.category === 'REQUEST' ||
      route?.startsWith('/requests') ||
      route?.includes('request')
    ) {
      if (role === 'STUDENT') return '/(student)/(tabs)/requests';
      if (
        role === 'FACULTY' ||
        SessionStore.hasAnyRole(['FACULTY', 'HEAD_OF_DEPARTMENT', 'CLASS_ADVISOR', 'ADMIN'])
      ) {
        return '/(faculty)/requests';
      }
      return null;
    }

    // 3. Delegations (e.g. /delegations or /delegations/approvals)
    if (
      item.category === 'DELEGATION' ||
      route?.startsWith('/delegations') ||
      route?.includes('delegation')
    ) {
      if (
        role === 'FACULTY' ||
        SessionStore.hasAnyRole(['FACULTY', 'HEAD_OF_DEPARTMENT', 'CLASS_ADVISOR'])
      ) {
        return '/(faculty)/delegations';
      }
      if (SessionStore.hasAnyRole(['ADMIN', 'INSTITUTION_OWNER', 'CENTRAL_INSTITUTION_ADMIN'])) {
        return '/(admin)/(tabs)/people';
      }
      return null;
    }

    // 4. Session attendance (e.g. /attendance/session/{id})
    if (route?.startsWith('/attendance/session/')) {
      if (role === 'STUDENT') return '/(student)/(tabs)/attendance';
      return '/(faculty)/(tabs)/assignments';
    }

    // 5. Shortage alerts (e.g. /analytics/shortage)
    if (item.category === 'ALERT' || route?.includes('shortage')) {
      if (role === 'STUDENT') return '/(student)/(tabs)/attendance';
      return '/(faculty)/(tabs)/reports';
    }

    // 6. Direct canonical routes
    if (
      route &&
      (route.startsWith('/(student)') ||
        route.startsWith('/(faculty)') ||
        route.startsWith('/(admin)'))
    ) {
      if (route.startsWith('/(admin)') && !SessionStore.canManageSettings() && role !== 'ADMIN') {
        if (role === 'STUDENT') return '/(student)/(tabs)';
        if (role === 'FACULTY') return '/(faculty)/(tabs)';
      }
      return route;
    }

    return route || null;
  };

  const handleNotificationPress = async (item: NotificationItem) => {
    if (!item.is_read) {
      await NotificationRepository.markAsRead(item.id, token);
      setNotifications((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, is_read: true } : n))
      );
    }

    if (item.category === 'SYSTEM' && isPendingUpdateAvailable()) {
      Alert.alert(
        'Apply Update Now?',
        'A downloaded Klasio update is ready to be applied. Would you like to restart now?',
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Restart Now',
            style: 'default',
            onPress: async () => {
              await applyUpdateAndReload();
            },
          },
        ]
      );
      return;
    }

    const targetRoute = resolveSafeActionRoute(item);
    if (targetRoute) {
      try {
        router.push(targetRoute as any);
      } catch (e) {
        console.warn('Notification navigation error:', e);
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
      case 'SYSTEM':
        return <Sparkles size={18} color={Colors.forest} />;
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
      onBack={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/');
        }
      }}
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
                            ? 'forest'
                            : item.category === 'ALERT'
                            ? 'apricot'
                            : 'soft'
                        }
                      >
                        {item.category}
                      </Chip>

                      {resolveSafeActionRoute(item) && (
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
