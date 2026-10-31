/**
 * Centralized Brand & Product Identity Configuration for Klasio Mobile.
 *
 * All user-facing product branding, taglines, descriptors, and academic
 * project identifiers must be sourced from here rather than hardcoded strings.
 */

export const Brand = {
  name: 'Klasio',
  tagline: 'Every class, in sync.',
  descriptor: 'Smart attendance for every class.',
  description:
    'Klasio helps colleges take attendance, keep records in sync, and turn classroom data into useful insights.',
  academicTitle:
    'Automated Student Attendance Monitoring and Analytics System for Colleges',
  version: '1.0.0',
  cameraPermissionText:
    'Klasio needs access to your Camera to scan classroom attendance and student registration.',
} as const;

export const PRODUCT_NAME = Brand.name;
export const PRODUCT_TAGLINE = Brand.tagline;
export const PRODUCT_DESCRIPTOR = Brand.descriptor;
export const PRODUCT_DESCRIPTION = Brand.description;
export const ACADEMIC_PROJECT_TITLE = Brand.academicTitle;
