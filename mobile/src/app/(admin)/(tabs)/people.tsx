import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  Platform,
} from 'react-native';
import {
  Search,
  Plus,
  ChevronRight,
  Check,
  Users,
  GraduationCap,
} from 'lucide-react-native';

import { Screen, Card, Chip, Avatar, Sheet, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';

interface Person {
  id: string;
  name: string;
  sub: string;
  tag?: string | null;
  classesCount?: number;
  dept?: string;
}

const INITIAL_FACULTY: Person[] = [
  { id: 'f1', name: 'Dr. Lakshmi Iyer', dept: 'Computer Science', sub: 'Computer Science · 3 classes', classesCount: 3 },
  { id: 'f2', name: 'Prof. Rahul Menon', dept: 'Computer Science', sub: 'Computer Science · 2 classes', classesCount: 2 },
  { id: 'f3', name: 'Dr. Fatima Khan', dept: 'Mathematics', sub: 'Mathematics · 4 classes', classesCount: 4 },
  { id: 'f4', name: 'Prof. Daniel Joseph', dept: 'Electronics', sub: 'Electronics · 0 classes', tag: 'No classes', classesCount: 0 },
];

const INITIAL_STUDENTS: Person[] = [
  { id: 's1', name: 'Aarav Sharma', sub: '21CS037 · CSE 3A' },
  { id: 's2', name: 'Priya Nair', sub: '21CS038 · CSE 3A' },
  { id: 's3', name: 'Diya Patel', sub: '21CS036 · CSE 3A', tag: 'No Face ID' },
  { id: 's4', name: 'Rohan Mehta', sub: '21CS039 · CSE 3A' },
  { id: 's5', name: 'Ananya Iyer', sub: '21CS040 · CSE 3A' },
  { id: 's6', name: 'Pooja Pillai', sub: '21CS048 · CSE 3A', tag: 'No Face ID' },
  { id: 's7', name: 'Dev Chauhan', sub: '21CS053 · CSE 3A', tag: 'No Face ID' },
];

export default function AdminPeopleScreen() {
  const [who, setWho] = useState<'students' | 'faculty'>('students');
  const [query, setQuery] = useState('');
  const [assignFaculty, setAssignFaculty] = useState<Person | null>(null);
  const [students, setStudents] = useState<Person[]>(INITIAL_STUDENTS);
  const [faculty, setFaculty] = useState<Person[]>(INITIAL_FACULTY);

  useEffect(() => {
    async function loadDirectory() {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/admin/users?role=${who}`);
        if (res.ok) {
          const users = await res.json();
          if (Array.isArray(users) && users.length > 0) {
            const mapped: Person[] = users.map((u: any) => ({
              id: u.id,
              name: u.name,
              sub: u.subtitle || `${u.identifier || ''}`,
              tag: u.tag,
            }));
            if (who === 'students') setStudents(mapped);
            else setFaculty(mapped);
          }
        }
      } catch {
        // Fallback to initial directory
      }
    }
    loadDirectory();
  }, [who]);

  const list = (who === 'students' ? students : faculty).filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <Screen
      title="People"
      subtitle="Directory and role assignments"
      scrollable
    >
      {/* Segmented Control */}
      <View style={styles.segmentContainer}>
        <Pressable
          onPress={() => setWho('students')}
          style={[
            styles.segmentButton,
            who === 'students' && styles.segmentButtonActive,
          ]}
        >
          <Text
            style={[
              styles.segmentText,
              who === 'students' && styles.segmentTextActive,
            ]}
          >
            Students
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setWho('faculty')}
          style={[
            styles.segmentButton,
            who === 'faculty' && styles.segmentButtonActive,
          ]}
        >
          <Text
            style={[
              styles.segmentText,
              who === 'faculty' && styles.segmentTextActive,
            ]}
          >
            Faculty
          </Text>
        </Pressable>
      </View>

      {/* Search Input */}
      <View style={styles.searchBox}>
        <Search size={18} color={Colors.soft} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${who}…`}
          placeholderTextColor={Colors.soft}
          style={styles.searchInput}
        />
      </View>

      {/* Directory List */}
      <Card style={styles.listCard}>
        {list.map((person, index) => (
          <View key={person.id}>
            {index > 0 && <View style={styles.divider} />}
            <Pressable
              onPress={() => {
                if (who === 'faculty') setAssignFaculty(person);
              }}
              style={({ pressed }) => [
                styles.personRow,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Avatar name={person.name} size={40} />
              <View style={styles.personTextCol}>
                <Text style={styles.personName}>{person.name}</Text>
                <Text style={styles.personSub}>{person.sub}</Text>
              </View>
              {person.tag && <Chip tone="amber">{person.tag}</Chip>}
              <ChevronRight size={16} color={Colors.soft} />
            </Pressable>
          </View>
        ))}
      </Card>

      {/* Assign Class Sheet for Faculty */}
      {assignFaculty && (
        <Sheet visible={!!assignFaculty} onClose={() => setAssignFaculty(null)}>
          <View style={styles.sheetHeader}>
            <Avatar name={assignFaculty.name} size={48} />
            <View style={styles.sheetHeaderCol}>
              <Text style={styles.sheetFacultyName}>{assignFaculty.name}</Text>
              <Text style={styles.sheetFacultyDept}>{assignFaculty.dept || 'Department'}</Text>
            </View>
          </View>

          <Text style={styles.sheetSectionTitle}>
            Classes they can take attendance for
          </Text>

          <View style={styles.assignedClassesList}>
            {['Data Structures · CSE 3A', 'Operating Systems · CSE 3B', 'DS Lab · CSE 3A']
              .slice(0, Math.max(assignFaculty.classesCount || 1, 1))
              .map((c, i) => (
                <View key={c} style={styles.assignedClassRow}>
                  <Text style={styles.assignedClassText}>{c}</Text>
                  {assignFaculty.classesCount ? (
                    <Check size={18} color={Colors.forest} strokeWidth={2.5} />
                  ) : (
                    <Chip tone="soft">Suggested</Chip>
                  )}
                </View>
              ))}
          </View>

          <Button
            onPress={() => setAssignFaculty(null)}
            style={styles.assignClassButton}
          >
            <Plus size={16} color="#ffffff" />
            <Text style={styles.assignClassButtonText}>Assign a class</Text>
          </Button>
        </Sheet>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: Colors.line,
    borderRadius: Radii.button,
    padding: 4,
    marginBottom: 12,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: Radii.button - 4,
  },
  segmentButtonActive: {
    backgroundColor: Colors.card,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.soft,
  },
  segmentTextActive: {
    color: Colors.ink,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.card,
    borderRadius: Radii.button,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: Colors.line,
    marginBottom: 16,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 14,
    color: Colors.ink,
  },
  listCard: {
    padding: 12,
    marginBottom: 20,
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  personTextCol: {
    flex: 1,
  },
  personName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  personSub: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.line,
    marginVertical: 10,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  sheetHeaderCol: {
    flex: 1,
  },
  sheetFacultyName: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.ink,
  },
  sheetFacultyDept: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 2,
  },
  sheetSectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
    marginTop: 8,
    marginBottom: 10,
  },
  assignedClassesList: {
    gap: 8,
  },
  assignedClassRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.line,
  },
  assignedClassText: {
    fontSize: 14,
    color: Colors.ink,
  },
  assignClassButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 20,
  },
  assignClassButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});
