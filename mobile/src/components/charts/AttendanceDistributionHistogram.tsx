import React, { useState } from 'react';
import { View, Text, StyleSheet, LayoutChangeEvent } from 'react-native';
import Svg, {
  Rect,
  Line,
  Text as SvgText,
  Defs,
  LinearGradient,
  Stop,
} from 'react-native-svg';
import { Colors, Radii } from '@/theme/tokens';

export interface HistogramBin {
  range: string;
  count: number;
  label: string;
  tone: 'rose' | 'amber' | 'neutral' | 'sage' | 'forest';
}

interface AttendanceDistributionHistogramProps {
  bins?: HistogramBin[];
  title?: string;
  height?: number;
}

const DEFAULT_BINS: HistogramBin[] = [
  { range: '<50%', count: 0, label: 'Critical', tone: 'rose' },
  { range: '50-64%', count: 0, label: 'Severe', tone: 'amber' },
  { range: '65-74%', count: 0, label: 'At-Risk', tone: 'neutral' },
  { range: '75-89%', count: 0, label: 'Good', tone: 'sage' },
  { range: '90-100%', count: 0, label: 'Top', tone: 'forest' },
];

const TONE_COLORS: Record<string, { fill: string; stroke: string }> = {
  rose: { fill: '#fee2e2', stroke: '#ef4444' },
  amber: { fill: '#fef3c7', stroke: '#f59e0b' },
  neutral: { fill: '#f3f4f6', stroke: '#9ca3af' },
  sage: { fill: '#d1fae5', stroke: '#10b981' },
  forest: { fill: '#059669', stroke: '#047857' },
};

export function AttendanceDistributionHistogram({
  bins = DEFAULT_BINS,
  title = 'Student Attendance Distribution',
  height = 195,
}: AttendanceDistributionHistogramProps) {
  const [containerWidth, setContainerWidth] = useState<number>(320);

  const handleLayout = (e: LayoutChangeEvent) => {
    const { width } = e.nativeEvent.layout;
    if (width > 50) {
      setContainerWidth(width);
    }
  };

  const paddingLeft = 32;
  const paddingRight = 16;
  const paddingTop = 24;
  const paddingBottom = 42;

  const chartWidth = Math.max(containerWidth - paddingLeft - paddingRight, 100);
  const chartHeight = height - paddingTop - paddingBottom;

  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const yAxisMax = Math.ceil(maxCount * 1.2);

  const binCount = bins.length;
  const slotWidth = chartWidth / binCount;
  const barWidth = Math.min(slotWidth * 0.7, 44);

  const getY = (val: number) => {
    return paddingTop + chartHeight * (1 - val / yAxisMax);
  };

  const totalStudents = bins.reduce((sum, b) => sum + b.count, 0);

  return (
    <View style={styles.container} onLayout={handleLayout}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.cohortCount}>{totalStudents} Students</Text>
      </View>

      <Svg width={containerWidth} height={height}>
        {/* Horizontal grid lines */}
        {[0, Math.round(yAxisMax / 2), yAxisMax].map((lvl, idx) => {
          const y = getY(lvl);
          return (
            <React.Fragment key={idx}>
              <Line
                x1={paddingLeft}
                y1={y}
                x2={containerWidth - paddingRight}
                y2={y}
                stroke="#e5e7eb"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <SvgText
                x={paddingLeft - 6}
                y={y + 3}
                fill={Colors.inkTertiary}
                fontSize={10}
                fontWeight="500"
                textAnchor="end"
              >
                {String(lvl)}
              </SvgText>
            </React.Fragment>
          );
        })}

        {/* Histogram Columns */}
        {bins.map((bin, i) => {
          const slotX = paddingLeft + i * slotWidth;
          const barX = slotX + (slotWidth - barWidth) / 2;
          const barY = getY(bin.count);
          const barH = Math.max(chartHeight - (barY - paddingTop), 4);
          const tone = TONE_COLORS[bin.tone] || TONE_COLORS.neutral;

          return (
            <React.Fragment key={bin.range}>
              <Rect
                x={barX}
                y={barY}
                width={barWidth}
                height={barH}
                rx={6}
                ry={6}
                fill={tone.fill}
                stroke={tone.stroke}
                strokeWidth={1.5}
              />

              {/* Count on top of column */}
              <SvgText
                x={barX + barWidth / 2}
                y={barY - 6}
                fill={Colors.ink}
                fontSize={11}
                fontWeight="700"
                textAnchor="middle"
              >
                {String(bin.count)}
              </SvgText>

              {/* Bin Range under column */}
              <SvgText
                x={barX + barWidth / 2}
                y={paddingTop + chartHeight + 15}
                fill={Colors.ink}
                fontSize={10}
                fontWeight="600"
                textAnchor="middle"
              >
                {bin.range}
              </SvgText>

              {/* Status label under bin range */}
              <SvgText
                x={barX + barWidth / 2}
                y={paddingTop + chartHeight + 28}
                fill={Colors.inkSecondary}
                fontSize={9}
                fontWeight="500"
                textAnchor="middle"
              >
                {bin.label}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#ffffff',
    borderRadius: Radii.lg,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
  },
  cohortCount: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.inkSecondary,
  },
});
