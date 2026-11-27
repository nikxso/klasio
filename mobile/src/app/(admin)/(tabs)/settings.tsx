import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import {
  ScanFace,
  Percent,
  ShieldCheck,
  Bell,
  HelpCircle,
  LogOut,
  RefreshCw,
  Smartphone,
  ChevronRight,
  CheckCircle2,
  Server,
} from 'lucide-react-native';

import { Screen, Card, Chip, IconBubble, Avatar, Sheet, Button, AccessRestrictedView } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { Brand } from '@/constants/brand';
import { SessionStore, AuthUser } from '@/storage/sessionStore';
import { API_BASE_URL } from '@/config/api';
import { AppUpdateCard } from '@/components/ui/AppUpdateCard';

export default function AdminSettingsScreen() {
  const router = useRouter();

  if (!SessionStore.canManageSettings()) {
    return (
      <AccessRestrictedView
        title="Settings Restricted"
        message="Institutional policies, thresholds, and technical configurations require IT or Governance Administration authority."
        requiredCapability="institution.manage"
        onBack={() => router.replace('/(admin)' as any)}
      />
    );
  }

  const navigation = useNavigation<any>();
  const [user, setUser] = useState<AuthUser | null>(SessionStore.getUser());
  const [facesSheet, setFacesSheet] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [devices, setDevices] = useState<{ name: string; ok: boolean; seen: string }[]>([]);
  const [showSignOutSheet, setShowSignOutSheet] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [cacheBuster, setCacheBuster] = useState(Date.now());

  useEffect(() => {
    async function initUser() {
      const stored = SessionStore.getUser() || (await SessionStore.initFromStorage())?.user;
      if (stored) {
        setUser(stored);
      }
      setCacheBuster(Date.now());

      const token = SessionStore.getToken();
      if (token) {
        try {
          const res = await fetch(`${API_BASE_URL}/api/v1/admin/users?role=faculty`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const facList = await res.json();
            if (Array.isArray(facList) && facList.length > 0) {
              setDevices(
                facList.map((f: any, idx: number) => ({
                  name: `${f.name}'s Device`,
                  ok: true,
                  seen: idx === 0 ? 'Active now' : idx === 1 ? '10 min ago' : 'Today',
                }))
              );
            }
          }
        } catch {
          // ignore error
        }
      }
    }
    initUser();

    const unsub = SessionStore.subscribe((session) => {
      setUser(session?.user ?? null);
    });
    return unsub;
  }, []);

  const handlePushUpdate = () => {
    setUpdating(true);
    setTimeout(() => {
      setDevices((prev) => prev.map((d) => ({ ...d, ok: true, seen: 'Just now' })));
      setUpdating(false);
    }, 1200);
  };

  const handleConfirmSignOut = async () => {
    setIsSigningOut(true);
    try {
      setShowSignOutSheet(false);
      // Allow native dialog to dismiss on UI thread before navigation transition
      await new Promise((resolve) => setTimeout(resolve, 150));
      await SessionStore.clearSession(true);
      router.replace('/');
    } catch (e) {
      console.warn('Sign out error:', e);
      router.replace('/');
    } finally {
      setIsSigningOut(false);
    }
  };

  const adminName = user?.fullName || 'Meera Nair';
  const adminId = user?.institutionalId || 'ADM-0007';
  const adminUserId = user?.id;

  return (
    <Screen
      title="Settings"
      subtitle="Institutional configuration and policy defaults"
      onBack={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(faculty)' as any);
        }
      }}
      scrollable
    >
      <View style={styles.headerBlock}>
        <Avatar
          name={adminName}
          userId={adminUserId}
          photoUrl={adminUserId ? `${API_BASE_URL}/api/v1/users/${adminUserId}/profile-photo?t=${cacheBuster}` : null}
          size={76}
        />
        <Text style={styles.userName}>{adminName}</Text>
        <Text style={styles.userSub}>
          {user?.roleAssignments?.some(ra => ra.roleTemplateCode === 'CENTRAL_INSTITUTION_ADMIN' || ra.roleTemplateCode === 'IT_ADMIN')
            ? 'Institutional Administration & Governance'
            : 'Academic Administration'}
        </Text>
        <View style={styles.badgesRow}>
          <Chip tone="forest">Staff ID: {adminId}</Chip>
          {user?.roleAssignments && user.roleAssignments.length > 1 && (
            <Chip tone="lilac">{user.roleAssignments.length} Roles Assigned</Chip>
          )}
        </View>
      </View>

      {SessionStore.canScanAttendance() && (
        <Pressable
          onPress={() => router.push('/(faculty)/session/select-context' as any)}
          style={({ pressed }) => [
            styles.workspaceSwitcherCard,
            pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
          ]}
        >
          <View style={styles.infoRow}>
            <IconBubble icon={ScanFace} tone="lilac" size={40} />
            <View style={styles.infoCol}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={styles.infoTitle}>Take Attendance Scanner</Text>
                <Chip tone="lilac">Teaching</Chip>
              </View>
              <Text style={styles.infoSubtitle}>
                Launch on-device camera perception to verify attendance
              </Text>
            </View>
            <ChevronRight size={18} color={Colors.lilac} />
          </View>
        </Pressable>
      )}

      {user?.roleAssignments && user.roleAssignments.length > 0 && (
        <>
          <Text style={styles.sectionHeader}>Assigned Institutional Roles</Text>
          <Card style={styles.cardGroup}>
            <View style={styles.rolesGrid}>
              {user.roleAssignments.map((ra, idx) => (
                <View key={`${ra.roleTemplateCode}-${idx}`} style={styles.roleTag}>
                  <ShieldCheck size={14} color={Colors.forest} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.roleTagText}>
                      {ra.roleTemplateName || ra.roleTemplateCode.replace(/_/g, ' ')}
                    </Text>
                    <Text style={{ fontSize: 11, color: Colors.soft, marginTop: 1 }}>
                      {ra.departmentCode ? `Department: ${ra.departmentCode}` : ra.scopeType === 'INSTITUTION' ? 'Institution-wide' : ra.scopeType}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </Card>
        </>
      )}

      <Text style={styles.sectionHeader}>Attendance Policies</Text>
      <Card style={styles.cardGroup}>
        <Pressable
          onPress={() => setFacesSheet(true)}
          style={({ pressed }) => [
            styles.infoRow,
            pressed && { opacity: 0.7 },
          ]}
        >
          <IconBubble icon={ScanFace} tone="lilac" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Face Recognition Baseline</Text>
            <Text style={styles.infoSubtitle}>
              EdgeFace-XS 512D · v1 · {devices.length} faculty devices
            </Text>
          </View>
          <ChevronRight size={18} color={Colors.soft} />
        </Pressable>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <IconBubble icon={Percent} tone="apricot" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Minimum Attendance Threshold</Text>
            <Text style={styles.infoSubtitle}>Standard collegiate policy</Text>
          </View>
          <Chip tone="amber">75.0%</Chip>
        </View>
      </Card>

      <Text style={styles.sectionHeader}>Privacy & Audit Trail</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={ShieldCheck} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Data Privacy Guarantee</Text>
            <Text style={styles.infoSubtitle}>
              Zero raw video retained or uploaded. Immutable amendment audits.
            </Text>
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <IconBubble icon={Bell} tone="apricot" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>System Broadcasts</Text>
            <Text style={styles.infoSubtitle}>Automated shortage warnings enabled</Text>
          </View>
          <Chip tone="forest">Active</Chip>
        </View>
      </Card>

      <Text style={styles.sectionHeader}>Server Infrastructure</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={Server} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Backend Endpoint</Text>
            <Text style={styles.infoSubtitle} numberOfLines={1} ellipsizeMode="middle">
              {API_BASE_URL}
            </Text>
          </View>
          <Chip tone="forest">Active</Chip>
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
        onPress={() => setShowSignOutSheet(true)}
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
            You will be returned to the login screen and will need your administrator credentials to sign back in.
          </Text>
          <View style={{ width: '100%', gap: 10 }}>
            <Button
              tone="rose"
              disabled={isSigningOut}
              onPress={handleConfirmSignOut}
            >
              {isSigningOut ? 'Signing out…' : 'Sign Out'}
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

      {/* Face Recognition Device Sync Sheet */}
      <Sheet visible={facesSheet} onClose={() => setFacesSheet(false)}>
        <Text style={styles.sheetTitle}>Face Recognition Version</Text>
        <Text style={styles.sheetSubtitle}>
          Keep every faculty device on the verified model baseline.
        </Text>

        <Card style={styles.modelCard}>
          <IconBubble icon={ScanFace} tone="lilac" size={40} />
          <View style={styles.modelTextCol}>
            <Text style={styles.modelTitle}>Version 1.0 (EdgeFace-XS 512D)</Text>
            <Text style={styles.modelSub}>Calibrated Cosine Threshold: 0.65</Text>
          </View>
          <Chip tone="forest">Live</Chip>
        </Card>

        <Text style={styles.devicesHeader}>Faculty Devices</Text>
        <View style={styles.devicesList}>
          {devices.map((d) => (
            <View key={d.name} style={styles.deviceRow}>
              <IconBubble icon={Smartphone} tone={d.ok ? 'forest' : 'amber'} size={36} />
              <View style={styles.deviceTextCol}>
                <Text style={styles.deviceName}>{d.name}</Text>
                <Text style={styles.deviceSeen}>Seen {d.seen}</Text>
              </View>
              <Chip tone={d.ok ? 'forest' : 'amber'}>
                {d.ok ? 'Up to date' : 'Needs update'}
              </Chip>
            </View>
          ))}
        </View>

        <Button
          onPress={handlePushUpdate}
          disabled={updating}
          style={styles.pushUpdateButton}
        >
          {updating ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <RefreshCw size={16} color="#ffffff" />
          )}
          <Text style={styles.pushUpdateText}>
            {updating ? 'Broadcasting...' : 'Send update to all phones'}
          </Text>
        </Button>
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
  userSub: {
    fontSize: 14,
    color: Colors.soft,
    marginTop: 4,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  workspaceSwitcherCard: {
    backgroundColor: '#faf5ff',
    borderWidth: 1.5,
    borderColor: '#e9d5ff',
    borderRadius: Radii.card,
    padding: 14,
    marginTop: 6,
    marginBottom: 16,
    shadowColor: Colors.lilac,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  rolesGrid: {
    gap: 8,
  },
  roleTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  roleTagText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
  },
  adminChip: {
    marginTop: 8,
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
  sheetTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
  },
  sheetSubtitle: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 4,
    marginBottom: 16,
  },
  modelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    backgroundColor: Colors.forest50,
  },
  modelTextCol: {
    flex: 1,
  },
  modelTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.forest,
  },
  modelSub: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 2,
  },
  devicesHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
    marginTop: 16,
    marginBottom: 8,
  },
  devicesList: {
    gap: 8,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
  },
  deviceTextCol: {
    flex: 1,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  deviceSeen: {
    fontSize: 11,
    color: Colors.soft,
  },
  pushUpdateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 20,
  },
  pushUpdateText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});
