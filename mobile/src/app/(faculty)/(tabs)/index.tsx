import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Bell,
  Clock,
  MapPin,
  ScanFace,
  CloudUpload,
  CloudOff,
  ChevronRight,
  BookOpen,
  UserCheck,
  BarChart3,
} from 'lucide-react-native';

import { Screen, Card, Chip, SectionTitle } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { KlasioLogo } from '@/components/ui/KlasioLogo';

const TODAY_CLASSES = [
  {
    id: 'ac8bf5c4-851a-4206-acf5-c8b174b1ae04',
    subject: 'Data Structures',
    section: 'CSE 3A',
    room: 'LH-204',
    time: '09:00',
    slotLabel: 'Next',
    startsIn: '12 min',
    held: 38,
    avg: 88,
  },
  {
    id: '428d32a5-2999-4206-ac52-d0a5cf20efcd',
    subject: 'Operating Systems',
    section: 'CSE 3B',
    room: 'LAB-2',
    time: '12:00',
    slotLabel: 'Later',
    held: 35,
    avg: 81,
  },
  {
    id: 'b7407716-9665-40fa-a177-b396a7f432cd',
    subject: 'Operating Systems',
    section: 'CSE 3A',
    room: 'LAB-4',
    time: '14:00',
    slotLabel: 'Afternoon',
    held: 14,
    avg: 92,
  },
];

export default function FacultyHomeScreen() {
  const router = useRouter();
  const [online] = useState(true);
  const [waitingRecords] = useState(0);

  const nextClass = TODAY_CLASSES[0];

  const handleOpenClass = (item: typeof TODAY_CLASSES[0]) => {
    router.push({
      pathname: '/(faculty)/section/[id]',
      params: {
        id: item.id,
        subject: item.subject,
        code: item.id,
        section: item.section,
        room: item.room,
        held: String(item.held),
        avg: String(item.avg),
        isDelegated: 'false',
        regularFaculty: '',
      },
    });
  };

  return (
    <Screen
      left={<KlasioLogo variant="lockup" size={24} />}
      subtitle="Good morning"
      title="Dr. Lakshmi Iyer"
      right={
        <View style={styles.headerRightActions}>
          <Pressable
            onPress={() => router.push('/(faculty)/reports' as any)}
            style={styles.iconButton}
            accessibilityLabel="Attendance Reports"
          >
            <BarChart3 size={19} color={Colors.ink} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/(faculty)/delegations' as any)}
            style={styles.iconButton}
            accessibilityLabel="Substitute Delegations"
          >
            <UserCheck size={19} color={Colors.ink} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/(faculty)/assignments' as any)}
            style={styles.iconButton}
            accessibilityLabel="All Classes"
          >
            <BookOpen size={19} color={Colors.ink} />
          </Pressable>
          <View style={styles.bellButtonWrapper}>
            <Pressable
              style={styles.iconButton}
              accessibilityLabel="Notifications"
            >
              <Bell size={19} color={Colors.ink} />
              <View style={styles.unreadDot} />
            </Pressable>
          </View>
        </View>
      }
    >
      {/* Next Class Hero Card */}
      <View style={styles.heroCard}>
        <View style={styles.heroFloatCircle} />

        <Chip tone="apricot" icon={<Clock size={12} color="#b86a2a" />}>
          Starts in {nextClass.startsIn}
        </Chip>

        <Text style={styles.heroClassTitle}>{nextClass.subject}</Text>

        <View style={styles.heroMetaRow}>
          <Text style={styles.heroMetaText}>{nextClass.section}</Text>
          <View style={styles.heroLocationRow}>
            <MapPin size={13} color="rgba(255,255,255,0.8)" />
            <Text style={styles.heroMetaText}>{nextClass.room}</Text>
          </View>
          <Text style={styles.heroMetaText}>{nextClass.time}</Text>
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.takeAttendanceButton,
            pressed && styles.takeAttendanceButtonPressed,
          ]}
          onPress={() => handleOpenClass(nextClass)}
        >
          <ScanFace size={19} color={Colors.forest} />
          <Text style={styles.takeAttendanceText}>Start attendance</Text>
        </Pressable>
      </View>

      {/* Offline / Sync Banner */}
      {(!online || waitingRecords > 0) && (
        <View style={styles.syncBanner}>
          {online ? (
            <CloudUpload size={20} color={Colors.amber} />
          ) : (
            <CloudOff size={20} color={Colors.amber} />
          )}
          <Text style={styles.syncBannerText}>
            {online
              ? `${waitingRecords} attendance ${waitingRecords > 1 ? 'records' : 'record'} waiting to upload`
              : "You're viewing saved data"}
          </Text>
          <ChevronRight size={18} color={Colors.soft} />
        </View>
      )}

      {/* Today's Classes List */}
      <SectionTitle
        action={
          <Pressable onPress={() => router.push('/(faculty)/assignments' as any)}>
            <Text style={styles.seeAllText}>All classes</Text>
          </Pressable>
        }
      >
        Your classes, at a glance
      </SectionTitle>
      <Text style={styles.sectionSubtitle}>
        Keep up with your classes and today's attendance.
      </Text>

      <View style={styles.classesList}>
        {TODAY_CLASSES.map((item) => (
          <Card
            key={item.id}
            onPress={() => handleOpenClass(item)}
            style={styles.classCard}
          >
            <View style={styles.timeColumn}>
              <Text style={styles.timeText}>{item.time}</Text>
              <Text style={styles.slotText}>{item.slotLabel}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.classDetails}>
              <Text style={styles.subjectText}>{item.subject}</Text>
              <Text style={styles.sectionText}>
                {item.section} · {item.room}
              </Text>
            </View>

            <ChevronRight size={18} color={Colors.soft} />
          </Card>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.card,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.line,
  },
  bellButtonWrapper: {
    position: 'relative',
  },
  unreadDot: {
    position: 'absolute',
    top: 7,
    right: 9,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.apricot,
  },
  heroCard: {
    backgroundColor: Colors.forest,
    borderRadius: 28,
    padding: 20,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: 14,
  },
  heroFloatCircle: {
    position: 'absolute',
    top: -24,
    right: -24,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(240, 168, 104, 0.35)',
  },
  heroClassTitle: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
    color: '#ffffff',
    marginTop: 12,
  },
  heroMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  heroLocationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  heroMetaText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.75)',
  },
  takeAttendanceButton: {
    marginTop: 20,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  takeAttendanceButtonPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.985 }],
  },
  takeAttendanceText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.forest,
  },
  syncBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.amber50,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
  },
  syncBannerText: {
    flex: 1,
    fontSize: 13,
    color: Colors.ink,
    fontWeight: '500',
  },
  classesList: {
    gap: 10,
    marginTop: 4,
  },
  classCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  timeColumn: {
    width: 52,
    alignItems: 'center',
  },
  timeText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
  },
  slotText: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 1,
  },
  divider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: Colors.line,
  },
  classDetails: {
    flex: 1,
  },
  subjectText: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  sectionText: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  seeAllText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.forest,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: -8,
    marginBottom: 12,
  },
});
