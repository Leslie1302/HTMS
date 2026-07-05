---
name: HTMS Ghana
colors:
  surface: '#f9f9ff'
  surface-dim: '#d3daef'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f1f3ff'
  surface-container: '#e9edff'
  surface-container-high: '#e1e8fd'
  surface-container-highest: '#dce2f7'
  on-surface: '#141b2b'
  on-surface-variant: '#40493d'
  inverse-surface: '#293040'
  inverse-on-surface: '#edf0ff'
  outline: '#707a6c'
  outline-variant: '#bfcaba'
  surface-tint: '#1b6d24'
  primary: '#0d631b'
  on-primary: '#ffffff'
  primary-container: '#2e7d32'
  on-primary-container: '#cbffc2'
  inverse-primary: '#88d982'
  secondary: '#2a6b2c'
  on-secondary: '#ffffff'
  secondary-container: '#acf4a4'
  on-secondary-container: '#307231'
  tertiary: '#4d5950'
  on-tertiary: '#ffffff'
  tertiary-container: '#657167'
  on-tertiary-container: '#e8f5e9'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#a3f69c'
  primary-fixed-dim: '#88d982'
  on-primary-fixed: '#002204'
  on-primary-fixed-variant: '#005312'
  secondary-fixed: '#acf4a4'
  secondary-fixed-dim: '#91d78a'
  on-secondary-fixed: '#002203'
  on-secondary-fixed-variant: '#0c5216'
  tertiary-fixed: '#d9e6da'
  tertiary-fixed-dim: '#bdcabe'
  on-tertiary-fixed: '#131e17'
  on-tertiary-fixed-variant: '#3e4a41'
  background: '#f9f9ff'
  on-background: '#141b2b'
  surface-variant: '#dce2f7'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  title-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.05em
  mono-data:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  container-max: 1440px
  gutter: 20px
---

## Brand & Style
The design system for the Haulage Tracking and Management System (HTMS) is anchored in **Corporate / Modern** principles, emphasizing authority, clarity, and national identity. It serves the Ministry of Energy and Green Transition by providing a high-utility environment for logistical oversight. 

The aesthetic is clean and institutional, utilizing heavy whitespace to balance dense data sets. It avoids decorative trends in favor of functional precision. The emotional goal is to evoke a sense of "stability and progress"—where the green transition is reflected in the palette and the professionalism of the Ministry is reflected in the structural rigor.

## Colors
The palette is dominated by **Forest Green**, signifying the Ministry's commitment to green transition and Ghana's natural resources. 

- **Primary Tier**: Forest Green (#2E7D32) is used for primary actions, branding, and active states.
- **Header Tier**: Near-black (Gray-900 / #111827) provides a grounding, authoritative contrast for navigation.
- **National Identity**: A specific tri-color accent strip (Red, Gold, Green) is applied as a 4px horizontal border immediately below the main header to establish sovereign context without overwhelming the interface.
- **Status Tints**: The Light Tint (#E8F5E9) is utilized for large surface backgrounds or subtle row highlights in data tables.

## Typography
**Inter** is selected for its exceptional legibility in data-heavy environments. 

- **Data Representation**: For financial figures (GHS / ₵) and haulage metrics, always use tabular numbers (`tnum`) to ensure columns of figures align vertically.
- **Date Formatting**: Strictly follow `DD-MMM-YYYY` (e.g., 12-OCT-2025) using `label-caps` for table headers and `mono-data` for row content.
- **Hierarchy**: Use `title-md` for KPI card titles and `display-lg` for primary metric values within those cards.

## Layout & Spacing
This design system utilizes a **12-column fluid grid** for desktop, transitioning to a single-column stacked layout for mobile. 

- **Information Density**: A tight 8px/16px rhythm is used to accommodate the complex 11-step pipeline and multi-column tables.
- **The Pipeline**: The 11-step pipeline should span the full width of the primary content area, utilizing a horizontal stepper on desktop and a vertical accordion-style list on mobile.
- **Margins**: Use 32px external margins on desktop to provide a professional "frame" for the application.

## Elevation & Depth
To maintain an official and professional tone, the design system avoids heavy shadows. Instead, it uses **Low-contrast outlines** and **Tonal layers**.

- **Level 0 (Background)**: Solid #F9FAFB (Gray-50).
- **Level 1 (Cards/Tables)**: Pure white surface with a 1px border in #E5E7EB (Gray-200).
- **Level 2 (Dropdowns/Modals)**: Pure white surface with a fine 8px blur, 10% opacity black shadow to differentiate from the base layout.
- **Interactive States**: Hover states on table rows should use the Primary Light Tint (#E8F5E9) rather than a shadow.

## Shapes
A **Soft** (0.25rem) corner radius is applied across the system to maintain a modern feel while remaining serious and institutional. 

- **Buttons & Inputs**: 4px (0.25rem) radius.
- **KPI Cards**: 8px (0.5rem) radius to distinguish them as high-level summary containers.
- **Status Chips**: 100px (Pill) radius to clearly differentiate status indicators from clickable buttons or data fields.

## Components
- **KPI Cards**: Feature a `title-md` label, a `display-lg` primary value in Forest Green, and a small trend indicator at the bottom.
- **Data Tables**: Use condensed row heights (40px). Headers must be `label-caps` with a subtle gray background. Primary identifiers (e.g., Truck ID) should be bold.
- **Status Chips**: Use semantic coloring (Success: Green, Warning: Gold, Alert: Red) with high-contrast text for accessibility.
- **11-Step Pipeline**: A custom horizontal progress indicator. Completed steps use Forest Green with a checkmark; the active step uses a thick Forest Green border; future steps use Gray-300.
- **Input Fields**: Standard 40px height with a 1px Gray-300 border. Focused states utilize a 2px Forest Green ring.
- **Currency Display**: Always prefix with "₵" or "GHS" using tabular mono-spacing for the decimal values to ensure financial alignment.