import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
} from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import {
  User,
  ShieldCheck,
  Smartphone,
  Cpu,
  RefreshCw,
  LogOut,
  ChevronRight,
  Clock,
  BookOpen,
  Users,
  GraduationCap,
  Bell,
  UserCheck,
} from 'lucide-react-native';

import { Screen, Card, Chip, IconBubble, Avatar, Sheet, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { AttendanceSyncWorker } from '@/storage/syncWorker';
import { SessionStore, AuthUser } from '@/storage/sessionStore';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { Brand } from '@/constants/brand';
import { API_BASE_URL } from '@/config/api';
import { AppUpdateCard } from '@/components/ui/AppUpdateCard';

export default function FacultyProfileScreen() {
  const router = useRouter();
  const navigation = useNavigation<any>();
  const [user, setUser] = useState<AuthUser | null>(SessionStore.getUser());
  const [pendingQueueCount, setPendingQueueCount] = useState<number>(0);
  const [syncing, setSyncing] = useState(false);
  const [showSignOutSheet, setShowSignOutSheet] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [cacheBuster, setCacheBuster] = useState(Date.now());

  useEffect(() => {
    async function initUserAndQueue() {
      const stored = SessionStore.getUser() || (await SessionStore.initFromStorage())?.user;
      if (stored) {
        setUser(stored);
      }
      setCacheBuster(Date.now());
      try {
        const items = await AttendanceSyncWorker.getPendingQueueItems();
        setPendingQueueCount(items.length);
      } catch {
        setPendingQueueCount(0);
      }
    }
    initUserAndQueue();

    const unsub = SessionStore.subscribe((session) => {
      setUser(session?.user ?? null);
    });
    return unsub;
  }, []);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const session = await SessionStore.initFromStorage();
      const res = await AttendanceSyncWorker.processPendingQueue(
        undefined,
        session?.token || SessionStore.getToken(),
        undefined,
        true
      );
      const items = await AttendanceSyncWorker.getPendingQueueItems(50, undefined, true);
      setPendingQueueCount(items.length);

      if (res.processed === 0) {
        Alert.alert('Everything Synced', 'All attendance sessions are already synchronized with the server.');
      } else if (res.succeeded > 0 && res.failed === 0) {
        Alert.alert('Sync Successful', `Successfully synchronized ${res.succeeded} offline attendance session(s).`);
      } else if (res.failed > 0) {
        Alert.alert(
          'Sync Incomplete',
          `${res.succeeded} session(s) synced. ${res.failed} session(s) remaining offline awaiting network connectivity.`
        );
      }
    } catch (err: any) {
      Alert.alert('Sync Failed', 'Could not connect to the synchronization server. Please check your internet connection.');
    } finally {
      setSyncing(false);
    }
  };

  const handleSignOutPress = async () => {
    try {
      const count = await SessionStore.hasPendingSync();
      setPendingQueueCount(count);
    } catch (_) {}
    setShowSignOutSheet(true);
  };

  const handleConfirmSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      setShowSignOutSheet(false);
      // Allow native dialog to dismiss on UI thread before navigation transition
      await new Promise((resolve) => setTimeout(resolve, 150));
      await SessionStore.clearSession(true);
    } catch (e) {
      console.warn('Sign out error:', e);
    } finally {
      setIsSigningOut(false);
    }
  };

  const facultyName = user?.fullName || 'Faculty Member';
  const facultyStaffId = user?.institutionalId || 'FACULTY';
  const facultyId = user?.id;

  const roleSummaryText =
    user?.roleAssignments && user.roleAssignments.length > 0
      ? user.roleAssignments
          .map((ra) => ra.roleTemplateName || ra.roleTemplateCode.replace(/_/g, ' '))
          .join(' · ')
      : 'Faculty Member';

  return (
    <Screen scrollable>
      <View style={styles.headerBlock}>
        <Avatar
          name={facultyName}
          userId={facultyId}
          photoUrl={facultyId ? `${API_BASE_URL}/api/v1/users/${facultyId}/profile-photo?t=${cacheBuster}` : null}
          size={76}
        />
        <Text style={styles.userName}>{facultyName}</Text>
        <Text style={styles.userRole} numberOfLines={2}>
          {roleSummaryText}
        </Text>
        <View style={styles.badgesRow}>
          <Chip tone="forest">Staff ID: {facultyStaffId}</Chip>
          {user?.roleAssignments && user.roleAssignments.length > 1 && (
            <Chip tone="lilac">{user.roleAssignments.length} Roles Active</Chip>
          )}
        </View>
      </View>

      {/* Institutional & Departmental Management Tools (Unified UX - No Workspace Switching) */}
      {(SessionStore.canManagePeople() ||
        SessionStore.canManageAcademics() ||
        SessionStore.canManageDelegations()) && (
        <>
          <Text style={styles.sectionHeader}>Departmental & Institutional Oversight</Text>
          <Card style={styles.cardGroup}>
            {SessionStore.canManagePeople() && (
              <>
                <Pressable
                  onPress={() => router.push('/(faculty)/people' as any)}
                  style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel="People & Student Rosters"
                  accessibilityHint="Manage department faculty, staff, and enrolled students"
                >
                  <View style={styles.actionLeft}>
                    <IconBubble icon={Users} tone="forest" size={36} />
                    <View>
                      <Text style={styles.actionTitle}>People & Student Rosters</Text>
                      <Text style={styles.actionSubtitle}>Department faculty, staff, and enrolled students</Text>
                    </View>
                  </View>
                  <ChevronRight size={18} color={Colors.soft} />
                </Pressable>
                <View style={styles.divider} />
              </>
            )}

            {SessionStore.canManageAcademics() && (
              <>
                <Pressable
                  onPress={() => router.push('/(faculty)/academics' as any)}
                  style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel="Academics & Class Sections"
                  accessibilityHint="View and manage curriculum, terms, sections, and assignments"
                >
                  <View style={styles.actionLeft}>
                    <IconBubble icon={GraduationCap} tone="lilac" size={36} />
                    <View>
                      <Text style={styles.actionTitle}>Academics & Class Sections</Text>
                      <Text style={styles.actionSubtitle}>Curriculum, terms, sections, and assignments</Text>
                    </View>
                  </View>
                  <ChevronRight size={18} color={Colors.soft} />
                </Pressable>
                <View style={styles.divider} />
              </>
            )}

            {SessionStore.canManageDelegations() && (
              <>
                <Pressable
                  onPress={() => router.push('/(faculty)/delegations' as any)}
                  style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel="Substitute Delegations"
                  accessibilityHint="Request or approve faculty classroom substitutions"
                >
                  <View style={styles.actionLeft}>
                    <IconBubble icon={UserCheck} tone="apricot" size={36} />
                    <View>
                      <Text style={styles.actionTitle}>Substitute Delegations</Text>
                      <Text style={styles.actionSubtitle}>Request or approve faculty classroom substitutions</Text>
                    </View>
                  </View>
                  <ChevronRight size={18} color={Colors.soft} />
                </Pressable>
                <View style={styles.divider} />
              </>
            )}

            <Pressable
              onPress={() => router.push('/notifications' as any)}
              style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityLabel="In-App Notification Center"
              accessibilityHint="View authority alerts, amendments, and governance notifications"
            >
              <View style={styles.actionLeft}>
                <IconBubble icon={Bell} tone="amber" size={36} />
                <View>
                  <Text style={styles.actionTitle}>In-App Notification Center</Text>
                  <Text style={styles.actionSubtitle}>Authority alerts, amendments, and governance</Text>
                </View>
              </View>
              <ChevronRight size={18} color={Colors.soft} />
            </Pressable>
          </Card>
        </>
      )}

      {user?.roleAssignments && user.roleAssignments.length > 0 && (
        <>
          <Text style={styles.sectionHeader}>Active Canonical Role Assignments</Text>
          <Card style={styles.cardGroup}>
            <View style={styles.rolesGrid}>
              {user.roleAssignments.map((ra, idx) => (
                <View key={`${ra.roleTemplateCode}-${idx}`} style={styles.roleCardItem}>
                  <View style={styles.roleIconCol}>
                    <ShieldCheck size={18} color={Colors.forest} />
                  </View>
                  <View style={styles.roleContentCol}>
                    <Text style={styles.roleNameText}>
                      {ra.roleTemplateName || ra.roleTemplateCode.replace(/_/g, ' ')}
                    </Text>
                    <View style={styles.roleScopeRow}>
                      <Chip tone="soft">
                        {ra.departmentCode
                          ? `Dept: ${ra.departmentCode}`
                          : ra.scopeType === 'INSTITUTION'
                          ? 'Institution-wide'
                          : ra.scopeType}
                      </Chip>
                      {ra.validUntil && (
                        <Text style={styles.roleValidityText}>Expires: {ra.validUntil.slice(0, 10)}</Text>
                      )}
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </Card>
        </>
      )}

      <Text style={styles.sectionHeader}>Biometric Perception & Device</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={Cpu} tone="lilac" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Edge Perception Engine</Text>
            <Text style={styles.infoSubtitle}>EdgeFace-XS 512D · v1-live</Text>
          </View>
          <Chip tone="forest">Active</Chip>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <IconBubble icon={Smartphone} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Device Authorization</Text>
            <Text style={styles.infoSubtitle}>Authorized for Roster Scopes</Text>
          </View>
          <Chip tone="forest">Verified</Chip>
        </View>
      </Card>

      <Text style={styles.sectionHeader}>Sync & Offline Storage</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={Clock} tone={pendingQueueCount > 0 ? 'amber' : 'forest'} size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Offline Queue</Text>
            <Text style={styles.infoSubtitle}>
              {syncing
                ? 'Syncing your changes…'
                : pendingQueueCount === 0
                ? 'Everything is up to date.'
                : `${pendingQueueCount} records waiting to sync`}
            </Text>
          </View>
          <Pressable
            onPress={handleSyncNow}
            disabled={syncing}
            style={({ pressed }) => [
              styles.syncButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <RefreshCw size={16} color={Colors.forest} />
          </Pressable>
        </View>
      </Card>

      <Text style={styles.sectionHeader}>Data Privacy & Standards</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={ShieldCheck} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Biometric Privacy Boundary</Text>
            <Text style={styles.infoSubtitle}>Zero raw classroom video retained or uploaded</Text>
          </View>
        </View>
      </Card>

      <Text style={styles.sectionHeader}>Software & System Updates</Text>
      <AppUpdateCard />

      <Text style={styles.sectionHeader}>About {Brand.name}</Text>
      <Card style={styles.cardGroup}>
        <View style={{ marginBottom: 8 }}>
          <KlasioLogo variant="lockup" size={20} />
        </View>
        <Text style={{ fontSize: 13, color: Colors.ink, fontWeight: '600', marginBottom: 2 }}>
          {Brand.descriptor}
        </Text>
        <Text style={{ fontSize: 12, color: Colors.soft, lineHeight: 17, marginBottom: 8 }}>
          {Brand.description}
        </Text>
        <Text style={{ fontSize: 11, color: Colors.soft }}>
          {Brand.academicTitle}
        </Text>
      </Card>

      <Pressable
        onPress={handleSignOutPress}
        style={({ pressed }) => [
          styles.signOutButton,
          pressed && { opacity: 0.8 },
        ]}
      >
        <LogOut size={18} color={Colors.rose} />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>

      {/* Sign Out Confirmation Sheet */}
      <Sheet visible={showSignOutSheet} onClose={() => setShowSignOutSheet(false)}>
        <View style={{ alignItems: 'center', paddingVertical: 12 }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff5f5', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
            <LogOut size={26} color={Colors.rose} />
          </View>
          <Text style={{ fontSize: 18, fontWeight: '700', color: Colors.ink, marginBottom: 6 }}>
            Sign out of Klasio?
          </Text>
          <Text style={{ fontSize: 13, color: Colors.soft, textAlign: 'center', paddingHorizontal: 20, marginBottom: 20 }}>
            {pendingQueueCount > 0
              ? `You have ${pendingQueueCount} offline attendance record(s) queued for synchronization. Signing out will preserve these records on this device.`
              : 'You will be returned to the login screen and will need your staff credentials to sign back in.'}
          </Text>
          <View style={{ width: '100%', gap: 10 }}>
            <Button
              tone="rose"
              disabled={isSigningOut}
              onPress={handleConfirmSignOut}
            >
              {isSigningOut ? 'Signing out…' : (pendingQueueCount > 0 ? 'Sign Out & Preserve Records' : 'Sign Out')}
            </Button>
            <Button
              tone="soft"
              disabled={isSigningOut}
              onPress={() => setShowSignOutSheet(false)}
            >
              Cancel
            </Button>
          </View>
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerBlock: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  userName: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 12,
  },
  userRole: {
    fontSize: 14,
    color: Colors.soft,
    marginTop: 4,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  rolesGrid: {
    gap: 10,
  },
  roleCardItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  roleIconCol: {
    marginTop: 2,
  },
  roleContentCol: {
    flex: 1,
  },
  roleNameText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  roleScopeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  roleValidityText: {
    fontSize: 11,
    color: Colors.soft,
  },
  actionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  actionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  actionSubtitle: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 1,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  cardGroup: {
    padding: 14,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  infoCol: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  infoSubtitle: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.line,
    marginVertical: 12,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  syncButton: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: Colors.forest50,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 28,
    marginBottom: 20,
    paddingVertical: 14,
    borderRadius: Radii.button,
    borderWidth: 1,
    borderColor: '#fbd0cc',
    backgroundColor: '#fff5f5',
  },
  signOutText: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.rose,
  },
});
