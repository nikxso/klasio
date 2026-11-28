import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  Platform,
  ToastAndroid,
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
  Trash2,
  X,
  ExternalLink,
  RefreshCw,
  Clock,
  ArrowRight,
} from 'lucide-react-native';

import { Screen, Card, Chip, SectionTitle, Sheet, Button, SkeletonList } from '@/components/ui/kit';
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
  const [activeDetailItem, setActiveDetailItem] = useState<NotificationItem | null>(null);

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
        SessionStore.hasAnyRole([
          'FACULTY',
          'HEAD_OF_DEPARTMENT',
          'CLASS_ADVISOR',
          'ADMIN',
          'INSTITUTION_OWNER',
          'CENTRAL_INSTITUTION_ADMIN',
          'CAMPUS_ADMIN',
        ])
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
    setActiveDetailItem(item);
  };

  const handleDeleteNotification = async (notificationId: string) => {
    try {
      await NotificationRepository.deleteNotification(notificationId);
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
      if (Platform.OS === 'android') {
        ToastAndroid.show('Notification deleted', ToastAndroid.SHORT);
      }
    } catch (e) {
      Alert.alert('Error', 'Failed to delete notification.');
    }
  };

  const handleClearAll = () => {
    Alert.alert(
      'Clear All Notifications?',
      'This will permanently delete all notifications from your device cache.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            try {
              await NotificationRepository.clearAllNotifications(userId);
              setNotifications([]);
              if (Platform.OS === 'android') {
                ToastAndroid.show('All notifications cleared', ToastAndroid.SHORT);
              }
            } catch (e) {
              Alert.alert('Error', 'Failed to clear notifications.');
            }
          },
        },
      ]
    );
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
        return <MessageSquare size={18} color="#2563eb" />;
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
        <View style={styles.headerActionsRow}>
          {unreadCount > 0 && (
            <Pressable
              onPress={handleMarkAllRead}
              style={styles.markAllButton}
              accessibilityLabel="Mark all as read"
            >
              <CheckCheck size={14} color={Colors.forest} />
              <Text style={styles.markAllText}>Mark read</Text>
            </Pressable>
          )}
          {notifications.length > 0 && (
            <Pressable
              onPress={handleClearAll}
              style={styles.clearAllButton}
              accessibilityLabel="Clear all notifications"
            >
              <Trash2 size={14} color={Colors.rose} />
              <Text style={styles.clearAllText}>Clear all</Text>
            </Pressable>
          )}
        </View>
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
          <SkeletonList count={5} lines={2} hasAvatar hasBadge />
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
            {notifications.map((item) => (
              <SwipeableNotificationCard
                key={item.id}
                item={item}
                onPress={() => handleNotificationPress(item)}
                onDelete={handleDeleteNotification}
                resolveSafeActionRoute={resolveSafeActionRoute}
                formatRelativeTime={formatRelativeTime}
                getCategoryIcon={getCategoryIcon}
              />
            ))}
          </View>
        )}
      </ScrollView>

      {/* Detailed Explanation Bottom Sheet */}
      <Sheet
        visible={!!activeDetailItem}
        onClose={() => setActiveDetailItem(null)}
      >
        {activeDetailItem && (
          <NotificationDetailBody
            item={activeDetailItem}
            onClose={() => setActiveDetailItem(null)}
            onDelete={(id) => {
              setActiveDetailItem(null);
              handleDeleteNotification(id);
            }}
            resolveSafeActionRoute={resolveSafeActionRoute}
            formatRelativeTime={formatRelativeTime}
          />
        )}
      </Sheet>
    </Screen>
  );
}

// -----------------------------------------------------------------------------
// Swipeable Notification Card
// -----------------------------------------------------------------------------
interface SwipeableCardProps {
  item: NotificationItem;
  onPress: () => void;
  onDelete: (id: string) => void;
  resolveSafeActionRoute: (item: NotificationItem) => string | null;
  formatRelativeTime: (isoString: string) => string;
  getCategoryIcon: (category: string, priority: string) => React.ReactNode;
}

function SwipeableNotificationCard({
  item,
  onPress,
  onDelete,
  resolveSafeActionRoute,
  formatRelativeTime,
  getCategoryIcon,
}: SwipeableCardProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const isDeletingRef = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 12 && Math.abs(gestureState.dy) < 15;
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dx < 0) {
          translateX.setValue(Math.max(gestureState.dx, -140));
        } else if (gestureState.dx > 0) {
          translateX.setValue(Math.min(gestureState.dx * 0.2, 20));
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx < -90) {
          if (!isDeletingRef.current) {
            isDeletingRef.current = true;
            Animated.timing(translateX, {
              toValue: -400,
              duration: 200,
              useNativeDriver: true,
            }).start(() => {
              onDelete(item.id);
            });
          }
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            friction: 7,
            tension: 40,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  const handleDeletePress = () => {
    if (!isDeletingRef.current) {
      isDeletingRef.current = true;
      Animated.timing(translateX, {
        toValue: -400,
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        onDelete(item.id);
      });
    }
  };

  return (
    <View style={styles.swipeContainer}>
      {/* Background Delete Button revealed on swipe */}
      <View style={styles.deleteBackground}>
        <Pressable
          onPress={handleDeletePress}
          style={styles.deleteBackgroundButton}
          accessibilityLabel="Delete notification"
        >
          <Trash2 size={20} color="#ffffff" />
          <Text style={styles.deleteBackgroundText}>Delete</Text>
        </Pressable>
      </View>

      {/* Foreground Card */}
      <Animated.View
        style={[
          styles.animatedCardWrapper,
          { transform: [{ translateX }] },
        ]}
        {...panResponder.panHandlers}
      >
        <Pressable
          style={[
            styles.notificationCard,
            !item.is_read && styles.notificationCardUnread,
          ]}
          onPress={onPress}
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

            <Text style={styles.notificationMessage} numberOfLines={2}>
              {item.message}
            </Text>

            <View style={styles.cardFooterRow}>
              <View style={styles.badgeRow}>
                <Chip
                  tone={
                    item.category === 'ATTENDANCE'
                      ? 'forest'
                      : item.category === 'ALERT'
                      ? 'rose'
                      : item.category === 'REQUEST'
                      ? 'apricot'
                      : 'soft'
                  }
                >
                  {item.category}
                </Chip>
                {item.priority && item.priority !== 'NORMAL' && (
                  <Chip tone={item.priority === 'URGENT' || item.priority === 'HIGH' ? 'rose' : 'amber'}>
                    {item.priority}
                  </Chip>
                )}
              </View>

              <View style={styles.actionPromptRow}>
                <View style={styles.viewLinkRow}>
                  <Text style={styles.viewLinkText}>Details</Text>
                  <ChevronRight size={12} color={Colors.forest} />
                </View>
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation?.();
                    handleDeletePress();
                  }}
                  hitSlop={8}
                  style={styles.cardDeleteIconBtn}
                  accessibilityLabel="Delete"
                >
                  <Trash2 size={13} color={Colors.inkTertiary} />
                </Pressable>
              </View>
            </View>
          </View>

          {!item.is_read && <View style={styles.unreadDot} />}
        </Pressable>
      </Animated.View>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Detailed Notification Bottom Sheet Content
// -----------------------------------------------------------------------------
interface DetailBodyProps {
  item: NotificationItem;
  onClose: () => void;
  onDelete: (id: string) => void;
  resolveSafeActionRoute: (item: NotificationItem) => string | null;
  formatRelativeTime: (isoString: string) => string;
}

function NotificationDetailBody({
  item,
  onClose,
  onDelete,
  resolveSafeActionRoute,
  formatRelativeTime,
}: DetailBodyProps) {
  const router = useRouter();
  const targetRoute = resolveSafeActionRoute(item);
  const isSystemUpdate =
    item.category === 'SYSTEM' || item.id?.startsWith('ota-') || item.title?.includes('Update');

  const handleDestinationAction = async () => {
    onClose();
    if (isSystemUpdate && isPendingUpdateAvailable()) {
      await applyUpdateAndReload();
      return;
    }
    if (targetRoute) {
      try {
        router.push(targetRoute as any);
      } catch (e) {
        console.warn('Navigation error:', e);
      }
    }
  };

  return (
    <View style={styles.sheetBody}>
      {/* Header bar with close button */}
      <View style={styles.sheetTopRow}>
        <View style={styles.sheetBadgeRow}>
          <Chip
            tone={
              item.category === 'ATTENDANCE'
                ? 'forest'
                : item.category === 'ALERT'
                ? 'rose'
                : item.category === 'REQUEST'
                ? 'apricot'
                : 'soft'
            }
          >
            {item.category}
          </Chip>
          {item.priority && item.priority !== 'NORMAL' && (
            <Chip tone={item.priority === 'URGENT' || item.priority === 'HIGH' ? 'rose' : 'amber'}>
              {item.priority} Priority
            </Chip>
          )}
        </View>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={styles.sheetCloseButton}
          accessibilityLabel="Close"
        >
          <X size={20} color={Colors.ink} />
        </Pressable>
      </View>

      <Text style={styles.sheetTitle}>{item.title}</Text>
      <View style={styles.timeInfoRow}>
        <Clock size={12} color={Colors.inkTertiary} />
        <Text style={styles.sheetTimeText}>
          {formatRelativeTime(item.created_at)} • {new Date(item.created_at).toLocaleString()}
        </Text>
      </View>

      <Text style={styles.sheetMessage}>{item.message}</Text>

      {/* Contextual In-Depth Explanation Box */}
      {isSystemUpdate ? (
        <View style={styles.explanationBox}>
          <View style={styles.explanationHeader}>
            <Sparkles size={16} color={Colors.forest} />
            <Text style={styles.explanationHeading}>What's New in this Klasio Release</Text>
          </View>
          <View style={styles.bulletList}>
            <Text style={styles.bulletItem}>
              • <Text style={styles.bulletBold}>Notification Center</Text>: Persistent local storage, swipe gestures to delete alerts, and 1-tap Clear All.
            </Text>
            <Text style={styles.bulletItem}>
              • <Text style={styles.bulletBold}>Native System Feedback</Text>: Real-time Android toast popups, haptic vibration, and in-app status bar HUD alerts.
            </Text>
            <Text style={styles.bulletItem}>
              • <Text style={styles.bulletBold}>Faculty Student Requests</Text>: Complete workflow for reviewing and resolving student attendance excuse petitions.
            </Text>
            <Text style={styles.bulletItem}>
              • <Text style={styles.bulletBold}>Offline Sync Integrity</Text>: Tamper-proof SQLite cache with automated cloud sync and zero-image biometrics.
            </Text>
          </View>
        </View>
      ) : item.category === 'REQUEST' ? (
        <View style={styles.explanationBox}>
          <View style={styles.explanationHeader}>
            <MessageSquare size={16} color="#2563eb" />
            <Text style={styles.explanationHeading}>Student Attendance Excuse</Text>
          </View>
          <Text style={styles.explanationText}>
            A student has submitted an excuse or amendment request for an attendance session. Faculty members and academic advisors can evaluate the justification, check supporting documentation, and approve or decline the request.
          </Text>
        </View>
      ) : item.category === 'ATTENDANCE' ? (
        <View style={styles.explanationBox}>
          <View style={styles.explanationHeader}>
            <CalendarDays size={16} color={Colors.forest} />
            <Text style={styles.explanationHeading}>Attendance Session Record</Text>
          </View>
          <Text style={styles.explanationText}>
            This attendance session was conducted using biometric face recognition or manual roster verification. Tapping below opens the full session roster and audit history.
          </Text>
        </View>
      ) : item.category === 'ALERT' ? (
        <View style={styles.explanationBox}>
          <View style={styles.explanationHeader}>
            <AlertTriangle size={16} color={Colors.rose} />
            <Text style={styles.explanationHeading}>Attendance Shortage Warning</Text>
          </View>
          <Text style={styles.explanationText}>
            Attendance is approaching or below the required 75% institutional threshold. Check your subject-wise analytics to review the minimum consecutive classes needed for recovery.
          </Text>
        </View>
      ) : item.category === 'DELEGATION' ? (
        <View style={styles.explanationBox}>
          <View style={styles.explanationHeader}>
            <ShieldCheck size={16} color="#7c3aed" />
            <Text style={styles.explanationHeading}>Institutional Delegation</Text>
          </View>
          <Text style={styles.explanationText}>
            An academic role or course session has been delegated. You can view active delegations and approve or revoke scoped permissions.
          </Text>
        </View>
      ) : null}

      {/* Action Buttons */}
      <View style={styles.sheetActionContainer}>
        {isSystemUpdate && isPendingUpdateAvailable() ? (
          <Button
            variant="primary"
            tone="forest"
            onPress={handleDestinationAction}
            icon={<RefreshCw size={16} color="#ffffff" />}
          >
            Restart App Now to Apply
          </Button>
        ) : targetRoute ? (
          <Button
            variant="primary"
            tone="forest"
            onPress={handleDestinationAction}
            icon={isSystemUpdate ? <ArrowRight size={16} color="#ffffff" /> : <ExternalLink size={16} color="#ffffff" />}
          >
            {isSystemUpdate
              ? 'View App Settings'
              : item.category === 'REQUEST'
              ? 'Open Student Requests'
              : item.category === 'ATTENDANCE'
              ? 'View Attendance Session'
              : item.category === 'ALERT'
              ? 'View Attendance & Recovery'
              : 'Take Me There'}
          </Button>
        ) : null}

        <View style={styles.sheetBottomButtonRow}>
          <Button
            variant="ghost"
            tone="rose"
            onPress={() => onDelete(item.id)}
            style={{ flex: 1 }}
            icon={<Trash2 size={16} color={Colors.rose} />}
          >
            Delete
          </Button>
          <Button
            variant="soft"
            onPress={onClose}
            style={{ flex: 1 }}
          >
            Close
          </Button>
        </View>
      </View>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------
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
  swipeContainer: {
    position: 'relative',
    borderRadius: Radii.lg,
    overflow: 'hidden',
  },
  deleteBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#ef4444',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    borderRadius: Radii.lg,
  },
  deleteBackgroundButton: {
    width: 90,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  deleteBackgroundText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  animatedCardWrapper: {
    backgroundColor: '#ffffff',
    borderRadius: Radii.lg,
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
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionPromptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
  cardDeleteIconBtn: {
    padding: 2,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.forest,
    marginTop: 6,
  },
  headerActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  markAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: Radii.sm,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
  },
  markAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.forest,
  },
  clearAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: Radii.sm,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
  },
  clearAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.rose,
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

  // Bottom Sheet Styles
  sheetBody: {
    paddingHorizontal: 4,
    paddingBottom: 24,
    gap: 12,
  },
  sheetTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  sheetBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sheetCloseButton: {
    padding: 4,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.ink,
    lineHeight: 24,
  },
  timeInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  sheetTimeText: {
    fontSize: 12,
    color: Colors.inkTertiary,
  },
  sheetMessage: {
    fontSize: 14,
    color: Colors.inkSecondary,
    lineHeight: 21,
    marginTop: 2,
  },
  explanationBox: {
    backgroundColor: '#f8fafc',
    borderRadius: Radii.md,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginTop: 6,
    gap: 8,
  },
  explanationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  explanationHeading: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.ink,
  },
  explanationText: {
    fontSize: 13,
    color: Colors.inkSecondary,
    lineHeight: 19,
  },
  bulletList: {
    gap: 6,
  },
  bulletItem: {
    fontSize: 12,
    color: Colors.inkSecondary,
    lineHeight: 18,
  },
  bulletBold: {
    fontWeight: '700',
    color: Colors.ink,
  },
  sheetActionContainer: {
    marginTop: 12,
    gap: 10,
  },
  sheetBottomButtonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
});
