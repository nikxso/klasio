import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Users,
  GraduationCap,
  Percent,
  Smartphone,
  ScanFace,
  AlertCircle,
  Link2,
  Check,
  ChevronRight,
  Bell,
} from 'lucide-react-native';

import { Screen, Card, Chip, IconBubble, SectionTitle, Avatar } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { SessionStore } from '@/storage/sessionStore';
import { NotificationRepository } from '@/storage/notificationRepository';

interface AdminMetric {
  label: string;
  value: string;
  icon: any;
  tone: 'forest' | 'lilac' | 'apricot' | 'amber';
}

export default function AdminHomeScreen() {
  const router = useRouter();
  const [metrics, setMetrics] = useState<AdminMetric[]>([]);
  const [approvals, setApprovals] = useState<{ id: string; name: string }[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isCancelled = false;
    async function loadOverview() {
      const token = SessionStore.getToken();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      try {
        setLoading(true);
        const [overviewRes, studentsRes, facultyRes] = await Promise.all([
          fetch(`${API_BASE_URL}/api/v1/analytics/overview`, { headers }),
          fetch(`${API_BASE_URL}/api/v1/admin/users?role=student`, { headers }),
          fetch(`${API_BASE_URL}/api/v1/admin/users?role=faculty`, { headers }),
        ]);

        let studentCount = 0;
        let facultyCount = 0;
        let pendingApprovals: { id: string; name: string }[] = [];

        if (studentsRes.ok) {
          const stuList = await studentsRes.json();
          if (Array.isArray(stuList)) {
            studentCount = stuList.length;
            pendingApprovals = stuList
              .filter((s: any) => s.tag === 'Pending' || s.face_registration_state === 'PENDING')
              .map((s: any) => ({ id: s.identifier || s.id, name: s.name }));
          }
        }

        if (facultyRes.ok) {
          const facList = await facultyRes.json();
          if (Array.isArray(facList)) {
            facultyCount = facList.length;
          }
        }

        let overallPct = 92;
        let totalSections = 3;

        if (overviewRes.ok) {
          const overview = await overviewRes.json();
          if (overview.overall_attendance_percentage != null) {
            overallPct = Math.round(overview.overall_attendance_percentage);
          }
          if (overview.total_sections) {
            totalSections = overview.total_sections;
          }
        }

        if (!isCancelled) {
          setMetrics([
            {
              label: 'Students',
              value: String(studentCount),
              icon: Users,
              tone: 'forest',
            },
            {
              label: 'Faculty',
              value: String(facultyCount),
              icon: GraduationCap,
              tone: 'lilac',
            },
            {
              label: 'Attendance',
              value: `${overallPct}%`,
              icon: Percent,
              tone: 'apricot',
            },
            {
              label: 'Sections',
              value: String(totalSections),
              icon: Smartphone,
              tone: 'amber',
            },
          ]);
          setApprovals(pendingApprovals);
        }
      } catch (e) {
        console.warn('Failed to load admin overview:', e);
      } finally {
        if (!isCancelled) setLoading(false);
      }

      const user = SessionStore.getUser();
      if (user) {
        const count = await NotificationRepository.getUnreadCount(user.id, token);
        if (!isCancelled) setUnreadCount(count);
      }
    }
    loadOverview();
    return () => {
      isCancelled = true;
    };
  }, []);

  const handleApprove = (id: string) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <Screen
      left={<KlasioLogo variant="lockup" size={24} />}
      subtitle="Keep track of academic activity and attendance across your institution."
      title="Your institution, at a glance"
      right={
        <Pressable
          style={styles.notificationWrapper}
          onPress={() => router.push('/notifications' as any)}
          accessibilityLabel="Notifications"
        >
          <Bell size={20} color={Colors.ink} />
          {unreadCount > 0 && <View style={styles.unreadDot} />}
        </Pressable>
      }
      scrollable
    >
      {/* 2x2 Metric Grid */}
      <View style={styles.metricsGrid}>
        {metrics.map((m) => {
          const Icon = m.icon;
          return (
            <Card key={m.label} style={styles.metricCard}>
              <IconBubble icon={Icon} tone={m.tone} size={38} />
              <Text style={styles.metricValue}>{m.value}</Text>
              <Text style={styles.metricLabel}>{m.label}</Text>
            </Card>
          );
        })}
      </View>

      {/* Needs Your Attention */}
      <SectionTitle>Institutional Management</SectionTitle>
      <View style={styles.attentionList}>
        {approvals.length > 0 ? (
          <Card style={styles.attentionCard}>
            <IconBubble icon={ScanFace} tone="lilac" size={40} />
            <View style={styles.attentionTextCol}>
              <Text style={styles.attentionTitle}>
                {approvals.length} Face ID registrations pending
              </Text>
              <Text style={styles.attentionSub}>New student biometric submissions</Text>
            </View>
            <Chip tone="amber">{approvals.length} pending</Chip>
          </Card>
        ) : (
          <Card style={styles.attentionCard}>
            <IconBubble icon={Check} tone="forest" size={40} />
            <View style={styles.attentionTextCol}>
              <Text style={styles.attentionTitle}>System Operational</Text>
              <Text style={styles.attentionSub}>All student face profiles & academic enrollments synced</Text>
            </View>
            <Chip tone="forest">All clear</Chip>
          </Card>
        )}

        <Card
          onPress={() => router.push('/(admin)/academics' as any)}
          style={styles.attentionCard}
        >
          <IconBubble icon={Link2} tone="forest" size={40} />
          <View style={styles.attentionTextCol}>
            <Text style={styles.attentionTitle}>Curriculum & Offerings</Text>
            <Text style={styles.attentionSub}>Configure departments, sections and subjects</Text>
          </View>
          <ChevronRight size={18} color={Colors.soft} />
        </Card>

        <Card
          onPress={() => router.push('/(admin)/people' as any)}
          style={styles.attentionCard}
        >
          <IconBubble icon={Users} tone="lilac" size={40} />
          <View style={styles.attentionTextCol}>
            <Text style={styles.attentionTitle}>People & Role Scopes</Text>
            <Text style={styles.attentionSub}>Assign faculty assignments and modify user roles</Text>
          </View>
          <ChevronRight size={18} color={Colors.soft} />
        </Card>
      </View>

      {/* Face ID Fast Approvals List */}
      {approvals.length > 0 && (
        <>
          <SectionTitle>Face ID approvals</SectionTitle>
          <Card style={styles.approvalsCard}>
            {approvals.map((student, index) => (
              <View key={student.id}>
                {index > 0 && <View style={styles.divider} />}
                <View style={styles.approvalRow}>
                  <Avatar name={student.name} size={38} />
                  <View style={styles.approvalTextCol}>
                    <Text style={styles.approvalName}>{student.name}</Text>
                    <Text style={styles.approvalId}>{student.id} · CSE 3A</Text>
                  </View>
                  <Pressable
                    onPress={() => handleApprove(student.id)}
                    style={styles.approveButton}
                  >
                    <Check size={14} color={Colors.forest} strokeWidth={2.5} />
                    <Text style={styles.approveButtonText}>Approve</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metricCard: {
    width: '48%',
    padding: 16,
  },
  metricValue: {
    fontSize: 26,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 10,
  },
  metricLabel: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  attentionList: {
    gap: 10,
  },
  attentionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  attentionTextCol: {
    flex: 1,
  },
  attentionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  attentionSub: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 2,
  },
  approvalsCard: {
    padding: 12,
    marginBottom: 20,
  },
  approvalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  approvalTextCol: {
    flex: 1,
  },
  approvalName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  approvalId: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 2,
  },
  approveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.forest50,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  approveButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.forest,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.line,
    marginVertical: 10,
  },
  notificationWrapper: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  unreadDot: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: Colors.forest,
  },
});
