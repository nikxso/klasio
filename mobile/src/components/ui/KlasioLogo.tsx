import React from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle, type ImageStyle } from 'react-native';
import { Brand } from '@/constants/brand';

export type KlasioLogoVariant = 'lockup' | 'mark' | 'white-mark';

export interface KlasioLogoProps {
  variant?: KlasioLogoVariant;
  size?: number;
  width?: number;
  height?: number;
  style?: StyleProp<ImageStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

const LOGO_ASSETS = {
  lockup: require('@/../assets/images/klasio-lockup.png'),
  mark: require('@/../assets/images/klasio-mark.png'),
  'white-mark': require('@/../assets/images/klasio-mark-white.png'),
};

/**
 * Aspect ratios from brand showcase:
 * lockup: 748 x 196 (~3.82 : 1)
 * mark: 192 x 196 (~0.98 : 1)
 */
export function KlasioLogo({
  variant = 'lockup',
  size = 32,
  width,
  height,
  style,
  containerStyle,
}: KlasioLogoProps) {
  let computedWidth: number;
  let computedHeight: number;

  if (variant === 'lockup') {
    computedHeight = height ?? size;
    computedWidth = width ?? Math.round(computedHeight * 3.82);
  } else {
    computedHeight = height ?? size;
    computedWidth = width ?? Math.round(computedHeight * 0.98);
  }

  return (
    <View style={containerStyle}>
      <Image
        source={LOGO_ASSETS[variant]}
        style={[
          {
            width: computedWidth,
            height: computedHeight,
          },
          style,
        ]}
        resizeMode="contain"
        accessibilityLabel={Brand.name}
      />
    </View>
  );
}
