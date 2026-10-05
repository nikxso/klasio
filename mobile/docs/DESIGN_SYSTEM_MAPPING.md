# Attendly Design System & Mobile UX Living Mapping

This document serves as the authoritative living bridge between the approved Figma designs in `designs/` and the mobile Expo application in `mobile/`. All mobile UI implementation must strictly follow this mapping.

---

## 1. Design Screen to Application Route Mapping

| Approved Design Screen | Design File & Component | Expo Mobile Route | Role(s) | Workflow / Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **Login / Sign In** | `designs/src/mobile/Login.tsx` | `mobile/src/app/index.tsx` | All (Student, Faculty, Admin) | Role selection pill cards, institutional ID / Staff ID / Roll number input, password visibility toggle, sign-in button. |
| **Faculty Home** | `designs/src/mobile/Faculty.tsx` (`Faculty:Home`) | `mobile/src/app/(faculty)/index.tsx` | Faculty | Next class hero card with apricot accent pill, offline/syncing banner, list of today's classes with room & time dividers. |
| **Faculty Classes** | `designs/src/mobile/Faculty.tsx` (`Faculty:Classes`) | `mobile/src/app/(faculty)/assignments.tsx` | Faculty | Permanent & delegated teaching assignments, class average rings, below-75% alerts, delegation chips. |
| **Faculty Section Roster** | `designs/src/mobile/Faculty.tsx` (`ClassDetail`) | `mobile/src/app/(faculty)/section/[id].tsx` | Faculty | Class metric hero card, "Take attendance" action, student roster with attendance percentage bars and face registration badges. |
| **Faculty Perception Camera** | `designs/src/mobile/Faculty.tsx` (`Scan`) | `mobile/src/app/(faculty)/session/scan.tsx` | Faculty | Viewfinder overlay, face bounding boxes (green recognised, dashed detecting), live candidate counter, pause/play, scanline animation. |
| **Faculty Review / Manual Fallback** | `designs/src/mobile/Faculty.tsx` (`Review`) | `mobile/src/app/(faculty)/session/review.tsx` | Faculty | Two-tab check (`Please check` vs `Recognised`), alert banner, `AttendanceRosterList` with Present/Absent toggles, "Mark rest as absent". |
| **Faculty Confirmation Sheet** | `designs/src/mobile/Faculty.tsx` (`Review:Sheet`) | Integrated via `Sheet` modal | Faculty | Save attendance prompt, green Present & rose Absent count cards, correction window notice, final submission confirmation. |
| **Faculty Session Done** | `designs/src/mobile/Faculty.tsx` (`Done`) | `mobile/src/app/(faculty)/session/done.tsx` | Faculty | Animated confetti particles, pulsing checkmark bubble, online/offline sync status notice, "Back to home". |
| **Faculty Uploads & Sync** | `designs/src/mobile/Faculty.tsx` (`Uploads`) | `mobile/src/app/(faculty)/uploads.tsx` | Faculty | Offline queue monitor, upload states (`saved` amber, `uploading` lilac spinner, `done` forest, `failed` rose), manual retry trigger. |
| **Faculty Reports** | `designs/src/mobile/Faculty.tsx` (`Reports`) | `mobile/src/app/(faculty)/reports.tsx` | Faculty | Horizontal course offering pills, weekly trend line chart with SVG gradient, "Students who need attention" risk cards. |
| **Faculty Delegation Management** | Figma `Faculty.tsx` extension | `mobile/src/app/(faculty)/delegations.tsx` | Faculty | Select colleague, calendar date window, mandatory justification input, immediate active state display, revocation action. |
| **Student Home** | `designs/src/mobile/Student.tsx` (`Student:Home`) | `mobile/src/app/(student)/index.tsx` | Student | Overall attendance ring with status banner, subject cards with `canMiss`/`toRecover` advice, Face ID setup/pending banner. |
| **Student Attendance & Calendar** | `designs/src/mobile/Student.tsx` (`Attendance`) | `mobile/src/app/(student)/attendance.tsx` | Student | Enrolled subject progress bars, interactive monthly calendar grid with colored day markers (`forest` present, `rose` absent, `amber` late). |
| **Student Mistake Report** | `designs/src/mobile/Student.tsx` (`NewRequest`) | `mobile/src/app/(student)/requests/new.tsx` | Student | Subject picker pills, day selector, justification textarea, direct submission to assigned faculty. |
| **Student Guided Face Registration** | `designs/src/mobile/Student.tsx` (`Enroll`) | `mobile/src/app/(student)/face-id/enroll.tsx` | Student | Pre-scan privacy & lighting guidelines, circular camera viewfinder with animated progress arc, pose prompts (straight, left, right, blink). |
| **Admin Home & Approvals** | `designs/src/mobile/Admin.tsx` (`Admin:Home`) | `mobile/src/app/(admin)/index.tsx` | Admin | 4-metric overview grid, attention list (pending Face IDs, device versions), Face ID approval list with 1-tap Approve action. |
| **Admin People & Allocations** | `designs/src/mobile/Admin.tsx` (`Admin:People`) | `mobile/src/app/(admin)/people.tsx` | Admin | Student/Faculty segment toggle, search bar, colleague list, teaching assignment bottom sheet. |
| **Admin Model & Devices** | `designs/src/mobile/Admin.tsx` (`faces`) | `mobile/src/app/(admin)/devices.tsx` | Admin | Active face model version badge, faculty device sync status list, OTA gallery model update push trigger. |
| **User Profile & Settings** | `designs/src/mobile/Profile.tsx` | `mobile/src/app/profile.tsx` | All | Large avatar header, grouped setting cards, switches, sign out button. |

---

## 2. Reusable Attendly Component Library (`mobile/src/components/ui/kit.tsx`)

| Component | Visual Styling & Dimensions | Purpose & Usage |
| :--- | :--- | :--- |
| **`Screen`** | Cream background (`#fbf6ee`), safe-area padding, customizable back button, right header action, subtitle and Fraunces title. | Primary root container for all screens. |
| **`Card`** | 24px border radius (`Radii.card`), cream card background (`#ffffff`), subtle warm border, soft shadow. Supports tone overrides (`apricot`, `forest`, `amber`). | Content groupings, offering items, metric panels. |
| **`Button`** | 16px border radius, 52px height, bold font, press scale effect. Variants: `primary` (forest), `soft` (forest-50), `ghost`. | Primary calls-to-action throughout workflows. |
| **`SectionTitle`** | 15px font, bold, plum ink, with optional right-aligned action link (forest color). | Section headers across screens. |
| **`Chip`** | Pill badge, rounded-full, 11px semi-bold text. Tones: `forest`, `rose`, `amber`, `lilac`, `apricot`, `soft`. | Status indicators, tags, face ID badges, delegation notices. |
| **`IconBubble`** | 44px rounded-2xl square with tone-tinted background and centered Lucide icon. | List item icon anchors, alerts, category badges. |
| **`Ring`** | SVG circular progress meter with 10px stroke, Fraunces percentage center, color dynamically mapped to 75% threshold (`forest` >= 75%, `rose` < 75%). | Key metric visualizations on Home and Class cards. |
| **`Bar`** | 8px rounded track (`#efe7da`), colored progress fill, vertical notch indicator at 75% threshold. | Subject-level attendance progress tracking. |
| **`Avatar`** | Circular badge with deterministic color palette based on name hash, bold initials. | Student, faculty, and administrator portraits. |
| **`Sheet`** | Modal bottom sheet with 32px top corners, backdrop blur/tint, drag handle, action buttons. | Confirmations, quick pickers, correction forms, delegation dialogs. |
| **`AttendanceRosterList`** | Divided card list with avatar, name, ID, biometric chips, and circular Present/Absent action buttons. | Attendance review and manual verification. |

---

## 3. Interaction & Application State Patterns

Every mobile workflow must implement the following states according to the Attendly design guidelines:

1. **Loading State**:
   - Replaces primary button text with spinning indicator (`<span className="spin" />`).
   - Uses subtle pulse on cards or skeleton placeholders preserving layout boundaries.
2. **Empty State**:
   - Centered icon bubble with `soft` or `lilac` tone, friendly 14px message in `Colors.soft` (e.g., "No classes scheduled for today").
3. **Error State**:
   - Rose tone (`#d65f57`), `AlertCircle` icon bubble, `Colors.rose50` background tint.
   - Clear human explanation without technical jargon.
4. **Validation State**:
   - Border transitions to `Colors.rose` on input failure.
   - Inline guidance helper text in 12px rose font below the field.
5. **Offline State**:
   - Sticky top amber banner (`#fcf4e8`) with `CloudOff` icon: "You're offline — attendance is saved on your phone".
   - Actions remain interactive; items queue into local SQLite `sync_queue`.
6. **Syncing / In-Flight State**:
   - Lilac tone card with spinning loader: "Uploading 2 sessions to college records...".
7. **Success & Done State**:
   - Fullscreen celebration overlay (`#1f1a29` or cream), animated confetti particles, large pulsing checkmark bubble (`Colors.forest`).
8. **Confirmation State**:
   - Modal bottom sheet with summary counters (e.g., Present vs Absent in colored boxes) and audit provenance explanation before finalizing.
9. **Disabled State**:
   - 40% opacity, non-interactive, accessible label indicating reason for disabled state.

---

## 4. Pre-Phase 7 UI/Design Compliance Audit & Verification Log

| Evaluated Screen | Approved Figma Design | Compliance Status | Deviations Identified & Categorization | Corrective Action Applied |
| :--- | :--- | :--- | :--- | :--- |
| **Login / Sign In** | `designs/src/mobile/Login.tsx` | **Verified & Compliant** | **Accidental Visual Deviation**: `mobile/src/app/index.tsx` was still running the stock Expo starter welcome screen. | Implemented full Attendly Login screen with exact Figma layout: 42% curved forest hero, floating apricot/white spheres, lowercase "a" mark, Fraunces brand header, 3-column role picker cards, styled inputs with password visibility toggle, and primary action button. |
| **Faculty Home** | `designs/src/mobile/Faculty.tsx` (`Faculty:Home`) | **Verified & Compliant** | **Accidental Visual Deviation**: Route `mobile/src/app/(faculty)/index.tsx` was missing. | Implemented Faculty Home matching Figma: Good morning header with unread bell, 28px radius forest hero card with "Starts in 12 min" apricot pill and "Take attendance" action, offline/sync banner, and "Today's classes" cards with time dividers and chevron anchors. |
| **Faculty Classes** | `designs/src/mobile/Faculty.tsx` (`Faculty:Classes`) | **Verified & Compliant** | **Responsive Adaptation**: `Ring` stroke slightly adjusted (from 8px to 10px) to match 60px ring proportions. **Intentional Adaptation**: Added apricot chip for active substitute delegations (FR-015/016). | Updated `Ring` dimensions (`size={60}`, `stroke={10}`), verified card gap, subtitle, and below-75% warning chips. |
| **Section Roster** | `designs/src/mobile/Faculty.tsx` (`ClassDetail`) | **Verified & Compliant** | **Intentional Adaptation**: Integrated biometric registration status chips (`REGISTERED`, `PENDING`, `UNREGISTERED`) per FR-012/FR-013. | Maintained 24px card container, `divide-y divide-line` borders, 36px/40px avatars, and attendance progress bar with 75% notch. |
| **Review & Manual Marks** | `designs/src/mobile/Faculty.tsx` (`Review`) | **Verified & Compliant** | **Accidental Visual Deviation**: Top segmented control (`Please check · X` vs `Recognised · Y`) was missing; lilac alert banner lacked `AlertCircle` icon. | Added segmented tab control (`Please check` vs `Recognised`), added `AlertCircle` to lilac guidance banner, wired list filtering, and verified circular Present/Absent action buttons. |
| **Confirmation Sheet** | `designs/src/mobile/Faculty.tsx` (`Review:Sheet`) | **Verified & Compliant** | None. Exact visual match. | Verified 32px top-radius sheet, Present (forest-50) & Absent (rose-50) metric boxes, and provenance explanation. |
| **Substitute Delegations** | Attendly Design System (`Faculty.tsx` extension) | **Verified & Compliant** | None. Designed directly from Attendly primitives. | Verified forest notice card, colleague avatars, date range inputs, justification textarea, and revocation confirmation sheet. |
| **Student Attendance & Calendar** | `designs/src/mobile/Student.tsx` (`Attendance`) | **Verified & Compliant** | **Intentional Adaptation**: Added late-admission zero unearned absences chip (FR-014). | Verified subject cards, recovery formulas, 7-column calendar grid with rounded cells, colored day markers (forest/rose/amber), today border ring, and legend. |
| **Root Navigation Layout** | `mobile/src/app/_layout.tsx` | **Verified & Compliant** | **Accidental Visual Deviation**: Unused starter tab layout was wrapping root. | Replaced root layout with clean Expo `Stack` navigation, dark status bar, and cream background. |

