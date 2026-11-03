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

export interface BarChartItem {
  label: string;
  value: number;
  secondaryLabel?: string;
  id?: string;
}

interface AttendanceBarChartProps {
  data: BarChartItem[];
  threshold?: number;
  height?: number;
  unit?: string;
  title?: string;
}

export function AttendanceBarChart({
  data,
  threshold = 75,
  height = 190,
  unit = '%',
  title,
}: AttendanceBarChartProps) {
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
  const paddingBottom = 34;

  const chartWidth = Math.max(containerWidth - paddingLeft - paddingRight, 100);
  const chartHeight = height - paddingTop - paddingBottom;

  const barCount = Math.max(data.length, 1);
  const totalBarSlotWidth = chartWidth / barCount;
  const barWidth = Math.min(Math.max(totalBarSlotWidth * 0.55, 18), 36);

  // Y-axis coordinates (0 to 100%)
  const getY = (val: number) => {
    const clamped = Math.max(0, Math.min(100, val));
    return paddingTop + chartHeight * (1 - clamped / 100);
  };

  const thresholdY = getY(threshold);

  return (
    <View style={styles.container} onLayout={handleLayout}>
      {title && <Text style={styles.title}>{title}</Text>}

      <Svg width={containerWidth} height={height}>
        <Defs>
          {/* Forest Green Gradient (Above Threshold) */}
          <LinearGradient id="barGreen" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="#10b981" stopOpacity="1" />
            <Stop offset="100%" stopColor="#059669" stopOpacity="0.85" />
          </LinearGradient>

          {/* Rose/Coral Gradient (Below Threshold) */}
          <LinearGradient id="barRose" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="#f43f5e" stopOpacity="1" />
            <Stop offset="100%" stopColor="#e11d48" stopOpacity="0.85" />
          </LinearGradient>
        </Defs>

        {/* Horizontal Grid Lines at 0%, 50%, 100% */}
        {[0, 50, 100].map((level) => {
          const y = getY(level);
          return (
            <React.Fragment key={level}>
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
                {`${level}%`}
              </SvgText>
            </React.Fragment>
          );
        })}

        {/* 75% Threshold Target Line */}
        <Line
          x1={paddingLeft}
          y1={thresholdY}
          x2={containerWidth - paddingRight}
          y2={thresholdY}
          stroke="#f59e0b"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        <SvgText
          x={containerWidth - paddingRight}
          y={thresholdY - 5}
          fill="#d97706"
          fontSize={10}
          fontWeight="700"
          textAnchor="end"
        >
          {`${threshold}% Target`}
        </SvgText>

        {/* Bars */}
        {data.map((item, index) => {
          const slotX = paddingLeft + index * totalBarSlotWidth;
          const barX = slotX + (totalBarSlotWidth - barWidth) / 2;
          const barY = getY(item.value);
          const barH = Math.max(chartHeight - (barY - paddingTop), 4);
          const isGood = item.value >= threshold;

          return (
            <React.Fragment key={item.id || index}>
              {/* Bar Fill */}
              <Rect
                x={barX}
                y={barY}
                width={barWidth}
                height={barH}
                rx={5}
                ry={5}
                fill={isGood ? 'url(#barGreen)' : 'url(#barRose)'}
              />

              {/* Top Value Label */}
              <SvgText
                x={barX + barWidth / 2}
                y={barY - 5}
                fill={isGood ? '#065f46' : '#9f1239'}
                fontSize={11}
                fontWeight="700"
                textAnchor="middle"
              >
                {`${Math.round(item.value)}${unit}`}
              </SvgText>

              {/* Bottom Subject / Axis Label */}
              <SvgText
                x={barX + barWidth / 2}
                y={paddingTop + chartHeight + 15}
                fill={Colors.ink}
                fontSize={11}
                fontWeight="600"
                textAnchor="middle"
              >
                {item.label}
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
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginBottom: 16,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
});
