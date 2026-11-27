import React, { useState } from 'react';
import { View, Text, StyleSheet, LayoutChangeEvent } from 'react-native';
import Svg, {
  Polyline,
  Polygon,
  Line,
  Circle,
  Text as SvgText,
  Defs,
  LinearGradient,
  Stop,
} from 'react-native-svg';
import { Colors, Radii } from '@/theme/tokens';

export interface TrendDataPoint {
  label: string;
  value: number;
}

interface AttendanceTrendLineChartProps {
  data: TrendDataPoint[];
  threshold?: number;
  height?: number;
  title?: string;
  strokeColor?: string;
  unit?: string;
}

export function AttendanceTrendLineChart({
  data,
  threshold = 75,
  height = 190,
  title,
  strokeColor = '#10b981',
  unit = '%',
}: AttendanceTrendLineChartProps) {
  const [containerWidth, setContainerWidth] = useState<number>(320);

  const handleLayout = (e: LayoutChangeEvent) => {
    const { width } = e.nativeEvent.layout;
    if (width > 50) {
      setContainerWidth(width);
    }
  };

  if (!data || data.length === 0) {
    return (
      <View style={styles.container}>
        {title && <Text style={styles.title}>{title}</Text>}
        <View style={{ paddingVertical: 28, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, color: Colors.inkTertiary }}>No attendance trend recorded yet</Text>
        </View>
      </View>
    );
  }

  const paddingLeft = 32;
  const paddingRight = 20;
  const paddingTop = 24;
  const paddingBottom = 34;

  const chartWidth = Math.max(containerWidth - paddingLeft - paddingRight, 100);
  const chartHeight = height - paddingTop - paddingBottom;

  const pointsCount = data.length;
  const stepX = pointsCount > 1 ? chartWidth / (pointsCount - 1) : chartWidth;

  const getY = (val: number) => {
    const clamped = Math.max(0, Math.min(100, val));
    return paddingTop + chartHeight * (1 - clamped / 100);
  };

  const coordinates = data.map((d, i) => ({
    x: paddingLeft + i * stepX,
    y: getY(d.value),
    val: d.value,
    label: d.label,
  }));

  const polylinePoints = coordinates.map((c) => `${c.x},${c.y}`).join(' ');

  // Bottom baseline for area fill
  const baselineY = paddingTop + chartHeight;
  const areaPolygonPoints = `${coordinates[0]?.x || paddingLeft},${baselineY} ${polylinePoints} ${
    coordinates[coordinates.length - 1]?.x || containerWidth - paddingRight
  },${baselineY}`;

  const thresholdY = getY(threshold);

  return (
    <View style={styles.container} onLayout={handleLayout}>
      {title && <Text style={styles.title}>{title}</Text>}

      <Svg width={containerWidth} height={height}>
        <Defs>
          <LinearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={strokeColor} stopOpacity="0.25" />
            <Stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
          </LinearGradient>
        </Defs>

        {/* Horizontal Grid Lines */}
        {[50, 75, 100].map((level) => {
          const y = getY(level);
          const isThreshold = level === threshold;
          return (
            <React.Fragment key={level}>
              <Line
                x1={paddingLeft}
                y1={y}
                x2={containerWidth - paddingRight}
                y2={y}
                stroke={isThreshold ? '#f59e0b' : '#e5e7eb'}
                strokeWidth={isThreshold ? 1.5 : 1}
                strokeDasharray={isThreshold ? '4 3' : '3 3'}
              />
              <SvgText
                x={paddingLeft - 6}
                y={y + 3}
                fill={isThreshold ? '#d97706' : Colors.inkTertiary}
                fontSize={10}
                fontWeight={isThreshold ? '700' : '500'}
                textAnchor="end"
              >
                {`${level}%`}
              </SvgText>
            </React.Fragment>
          );
        })}

        {/* Gradient Area Fill */}
        {coordinates.length > 1 && (
          <Polygon points={areaPolygonPoints} fill="url(#trendGradient)" />
        )}

        {/* Trend Polyline */}
        {coordinates.length > 1 && (
          <Polyline
            points={polylinePoints}
            fill="none"
            stroke={strokeColor}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Data Points (Circles) and Labels */}
        {coordinates.map((pt, idx) => {
          const isLast = idx === coordinates.length - 1;
          return (
            <React.Fragment key={idx}>
              <Circle
                cx={pt.x}
                cy={pt.y}
                r={isLast ? 5 : 4}
                fill="#ffffff"
                stroke={strokeColor}
                strokeWidth={isLast ? 2.5 : 2}
              />
              {/* Value Label */}
              <SvgText
                x={pt.x}
                y={pt.y - 7}
                fill={isLast ? Colors.ink : Colors.inkSecondary}
                fontSize={10}
                fontWeight={isLast ? '700' : '600'}
                textAnchor="middle"
              >
                {`${Math.round(pt.val)}${unit}`}
              </SvgText>
              {/* X Axis Label */}
              <SvgText
                x={pt.x}
                y={baselineY + 16}
                fill={Colors.inkSecondary}
                fontSize={10}
                fontWeight="500"
                textAnchor="middle"
              >
                {pt.label}
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
