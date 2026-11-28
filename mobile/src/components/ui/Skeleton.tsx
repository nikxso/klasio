import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, ViewStyle } from 'react-native';
import { Colors, Radii, Shadows } from '@/theme/tokens';

interface SkeletonProps {
  width?: number | `${number}%` | 'auto';
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
}

/**
 * Animated pulse placeholder block matching the Klasio warm-paper aesthetic.
 */
export function Skeleton({
  width = '100%',
  height = 14,
  borderRadius = 8,
  style,
}: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.9,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: 750,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        styles.base,
        { width: width as any, height, borderRadius, opacity },
        style,
      ]}
    />
  );
}

/**
 * Skeleton placeholder for a standard list/detail card (icon bubble + 2-3 lines).
 */
export function SkeletonCard({
  lines = 2,
  hasAvatar = true,
  hasBadge = false,
  style,
}: {
  lines?: number;
  hasAvatar?: boolean;
  hasBadge?: boolean;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.card, Shadows.card, style]}>
      <View style={styles.cardRow}>
        {hasAvatar && <Skeleton width={42} height={42} borderRadius={Radii.bubble} />}
        <View style={styles.cardLines}>
          <View style={styles.cardTopRow}>
            <Skeleton width="62%" height={15} borderRadius={6} />
            {hasBadge && <Skeleton width={64} height={22} borderRadius={Radii.pill} />}
          </View>
          {lines >= 2 && <Skeleton width="84%" height={12} borderRadius={6} />}
          {lines >= 3 && <Skeleton width="48%" height={11} borderRadius={6} />}
        </View>
      </View>
    </View>
  );
}

/**
 * Vertical stack of SkeletonCards for list-based screens.
 */
export function SkeletonList({
  count = 4,
  lines = 2,
  hasAvatar = true,
  hasBadge = false,
  gap = 12,
}: {
  count?: number;
  lines?: number;
  hasAvatar?: boolean;
  hasBadge?: boolean;
  gap?: number;
}) {
  return (
    <View style={{ gap }}>
      {Array.from({ length: count }).map((_, idx) => (
        <SkeletonCard
          key={idx}
          lines={lines}
          hasAvatar={hasAvatar}
          hasBadge={hasBadge}
        />
      ))}
    </View>
  );
}

/**
 * Horizontal row of pill/chip skeletons for picker options inside forms & sheets.
 */
export function SkeletonChips({ count = 4 }: { count?: number }) {
  const widths = [76, 92, 68, 104, 84];
  return (
    <View style={styles.chipsRow}>
      {Array.from({ length: count }).map((_, idx) => (
        <Skeleton
          key={idx}
          width={widths[idx % widths.length]}
          height={34}
          borderRadius={8}
        />
      ))}
    </View>
  );
}

/**
 * 2-column metric grid skeleton for dashboards.
 */
export function SkeletonMetricGrid({ count = 4 }: { count?: number }) {
  return (
    <View style={styles.metricGrid}>
      {Array.from({ length: count }).map((_, idx) => (
        <View key={idx} style={[styles.metricCard, Shadows.card]}>
          <Skeleton width={32} height={32} borderRadius={10} />
          <Skeleton width="55%" height={22} borderRadius={6} style={{ marginTop: 10 }} />
          <Skeleton width="75%" height={12} borderRadius={6} style={{ marginTop: 6 }} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: Colors.line,
  },
  card: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 16,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardLines: {
    flex: 1,
    gap: 8,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metricCard: {
    width: '48%',
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 16,
  },
});
