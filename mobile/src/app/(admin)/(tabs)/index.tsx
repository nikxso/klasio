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
} from 'lucide-react-native';

import { Screen, Card, Chip, IconBubble, SectionTitle, Avatar } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { KlasioLogo } from '@/components/ui/KlasioLogo';

interface AdminMetric {
  label: string;
  value: string;
  icon: any;
  tone: 'forest' | 'lilac' | 'apricot' | 'amber';
}

const INITIAL_METRICS: AdminMetric[] = [
  { label: 'Students', value: '1,240', icon: Users, tone: 'forest' },
  { label: 'Faculty', value: '86', icon: GraduationCap, tone: 'lilac' },
  { label: 'Today', value: '88%', icon: Percent, tone: 'apricot' },
  { label: 'Devices', value: '3/3', icon: Smartphone, tone: 'amber' },
];

const INITIAL_APPROVALS = [
  { id: '21CS036', name: 'Diya Patel' },
  { id: '21CS048', name: 'Pooja Pillai' },
  { id: '21CS053', name: 'Dev Chauhan' },
];

export default function AdminHomeScreen() {
  const router = useRouter();
  const [metrics, setMetrics] = useState<AdminMetric[]>(INITIAL_METRICS);
  const [approvals, setApprovals] = useState(INITIAL_APPROVALS);

  useEffect(() => {
    async function loadOverview() {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/analytics/overview`);
        if (res.ok) {
          const overview = await res.json();
          if (overview) {
            setMetrics([
              {
                label: 'Students',
                value: overview.total_students ? String(overview.total_students) : '1,240',
                icon: Users,
                tone: 'forest',
              },
              {
                label: 'Faculty',
                value: overview.total_faculty ? String(overview.total_faculty) : '86',
                icon: GraduationCap,
                tone: 'lilac',
              },
              {
                label: 'Today',
                value: overview.average_attendance_percentage
                  ? `${Math.round(overview.average_attendance_percentage)}%`
                  : '88%',
                icon: Percent,
                tone: 'apricot',
              },
              {
                label: 'Devices',
                value: '3/3',
                icon: Smartphone,
                tone: 'amber',
              },
            ]);
          }
        }
      } catch {
        // Fallback to initial institutional baselines
      }
    }
    loadOverview();
  }, []);

  const handleApprove = (id: string) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <Screen
      left={<KlasioLogo variant="lockup" size={24} />}
      subtitle="Keep track of academic activity and attendance across your institution."
      title="Your institution, at a glance"
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
      <SectionTitle>Needs your attention</SectionTitle>
      <View style={styles.attentionList}>
        {approvals.length > 0 && (
          <Card style={styles.attentionCard}>
            <IconBubble icon={ScanFace} tone="lilac" size={40} />
            <View style={styles.attentionTextCol}>
              <Text style={styles.attentionTitle}>
                {approvals.length} Face IDs to approve
              </Text>
              <Text style={styles.attentionSub}>New student biometric registrations</Text>
            </View>
            <Chip tone="amber">{approvals.length} pending</Chip>
          </Card>
        )}

        <Card
          onPress={() => router.push('/(admin)/settings' as any)}
          style={styles.attentionCard}
        >
          <IconBubble icon={AlertCircle} tone="amber" size={40} />
          <View style={styles.attentionTextCol}>
            <Text style={styles.attentionTitle}>1 phone needs an update</Text>
            <Text style={styles.attentionSub}>Fatima’s tablet · Model v2.3</Text>
          </View>
          <ChevronRight size={18} color={Colors.soft} />
        </Card>

        <Card
          onPress={() => router.push('/(admin)/people' as any)}
          style={styles.attentionCard}
        >
          <IconBubble icon={Link2} tone="apricot" size={40} />
          <View style={styles.attentionTextCol}>
            <Text style={styles.attentionTitle}>1 teacher has no classes</Text>
            <Text style={styles.attentionSub}>Prof. Daniel Joseph · Electronics</Text>
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
});
