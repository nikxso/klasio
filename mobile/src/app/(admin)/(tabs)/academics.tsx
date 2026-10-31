import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Building2,
  ChevronRight,
  Plus,
  BookOpen,
  Link2,
  Users,
} from 'lucide-react-native';

import { Screen, Card, IconBubble, SectionTitle } from '@/components/ui/kit';
import { Colors } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';

interface DepartmentItem {
  id: string;
  name: string;
  sections: number;
  subjects: number;
}

const INITIAL_DEPARTMENTS: DepartmentItem[] = [
  { id: 'dept-01', name: 'Computer Science & Engineering', sections: 6, subjects: 48 },
  { id: 'dept-02', name: 'Electronics & Communication', sections: 4, subjects: 32 },
  { id: 'dept-03', name: 'Mathematics & Basic Sciences', sections: 2, subjects: 18 },
];

export default function AdminAcademicsScreen() {
  const router = useRouter();
  const [departments, setDepartments] = useState<DepartmentItem[]>(INITIAL_DEPARTMENTS);

  useEffect(() => {
    async function loadDepts() {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/admin/departments/overview`);
        if (res.ok) {
          const depts = await res.json();
          if (Array.isArray(depts) && depts.length > 0) {
            setDepartments(
              depts.map((d: any) => ({
                id: d.id,
                name: d.name,
                sections: d.sections_count || 1,
                subjects: d.subjects_count || 1,
              }))
            );
          }
        }
      } catch {
        // Fallback to initial catalogue
      }
    }
    loadDepts();
  }, []);

  return (
    <Screen
      title="Academics"
      subtitle="Academic year 2026–27 · Odd semester"
      scrollable
    >
      <View style={styles.departmentsList}>
        {departments.map((d) => (
          <Card key={d.id} style={styles.deptCard}>
            <IconBubble icon={Building2} tone="forest" size={42} />
            <View style={styles.deptTextCol}>
              <Text style={styles.deptName}>{d.name}</Text>
              <Text style={styles.deptSub}>
                {d.sections} sections · {d.subjects} subjects
              </Text>
            </View>
            <ChevronRight size={18} color={Colors.soft} />
          </Card>
        ))}
      </View>

      <SectionTitle>Quick actions</SectionTitle>
      <View style={styles.actionsGrid}>
        <Card style={styles.actionCard}>
          <Plus size={24} color={Colors.forest} />
          <Text style={styles.actionLabel}>Add section</Text>
        </Card>

        <Card style={styles.actionCard}>
          <BookOpen size={24} color={Colors.forest} />
          <Text style={styles.actionLabel}>Add subject</Text>
        </Card>

        <Card
          onPress={() => router.push('/(admin)/people' as any)}
          style={styles.actionCard}
        >
          <Link2 size={24} color={Colors.forest} />
          <Text style={styles.actionLabel}>Assign teacher</Text>
        </Card>

        <Card style={styles.actionCard}>
          <Users size={24} color={Colors.forest} />
          <Text style={styles.actionLabel}>Import students</Text>
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  departmentsList: {
    gap: 10,
    marginBottom: 8,
  },
  deptCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  deptTextCol: {
    flex: 1,
  },
  deptName: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  deptSub: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
  },
  actionCard: {
    width: '48%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 8,
  },
  actionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
  },
});
