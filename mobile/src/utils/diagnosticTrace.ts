/**
 * Privacy-Safe Biometric Pipeline Diagnostic Logger
 * Development & diagnostic tracing without leaking raw biometric vectors, face crops, or tokens.
 */

export const DiagnosticTrace = {
  logEnrollment(stage: string, details: Record<string, any>) {
    if (__DEV__) {
      console.log(`[BIOMETRIC_TRACE][ENROLLMENT] ${stage}:`, JSON.stringify(details));
    }
  },

  logFacultyGallery(stage: string, details: Record<string, any>) {
    if (__DEV__) {
      console.log(`[BIOMETRIC_TRACE][FACULTY_GALLERY] ${stage}:`, JSON.stringify(details));
    }
  },

  logRecognition(stage: string, details: Record<string, any>) {
    if (__DEV__) {
      console.log(`[BIOMETRIC_TRACE][LIVE_RECOGNITION] ${stage}:`, JSON.stringify(details));
    }
  },

  logCandidateDelivery(stage: string, details: Record<string, any>) {
    if (__DEV__) {
      console.log(`[BIOMETRIC_TRACE][CANDIDATE_DELIVERY] ${stage}:`, JSON.stringify(details));
    }
  },
};
