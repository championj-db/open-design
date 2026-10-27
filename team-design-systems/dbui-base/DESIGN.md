---
name: "dbui Base"
category: Product UI
surface: web
colors:
  background: "#FFFFFF"
  surface: "#FAFAFA"
  text: "#333333"
  muted: "#666666"
  border: "#E5E5E5"
  primary: "#2272B4"
---

# dbui Base

> Category: Product UI
> dbui Base, the refreshed dbui theme: Figtree and Commit Mono, softer neutrals, pill-shaped buttons, rounder containers and layered elevation, with Blue 600 primary actions.

## Provenance and intended use

This package captures the **dbui Base** theme of dbui, the Databricks design system (`@databricks/design-system`, v2.0.15). Colors, type, radius and elevation come from that theme's published values; layout and copy guidance are OpenDesign adaptations.

Use it to mock up Databricks product screens, Databricks Apps, internal tools and dashboards in this theme. To build the real thing, use the dbui React components: `npx @databricks/design-system --theme base` scaffolds a project with this theme selected.

## Visual theme and atmosphere

Friendlier and more modern than Du Bois while staying a product UI: rounder shapes, pill buttons, a warmer gray text color (`#333333` instead of near-black) and a geometric sans. Still restrained — Blue 600 is the only brand color.

**Key signals**

- Light mode by default, with a full dark theme (values below).
- One primary action per view, filled `#2272B4`.
- Hierarchy from text color and weight, not from extra colors.
- Figtree (variable) for UI text, Commit Mono for code and identifiers.
- Corners: controls 4px, buttons 999px (pill).

## Color palette and roles

**Key colors (light)**

- **Page background**: `#FFFFFF`
- **Foreground text**: `#333333`
- **Primary accent**: `#2272B4`
- **Border**: `#E5E5E5`

| Token | Role name | Light | Dark | Use |
| --- | --- | --- | --- | --- |
| `--bg` | Background primary | `#FFFFFF` | `#11171C` | Page and panel canvas |
| `--surface` | Background secondary | `#FAFAFA` | `#1F272D` | Sidebars, table headers, recessed and selected areas |
| `--fg` | Text primary | `#333333` | `#E8ECF0` | Body text, headings, icons |
| `--muted` | Text secondary | `#666666` | `#92A4B3` | Descriptions, metadata, placeholders |
| `--border` | Border | `#E5E5E5` | `rgba(255,255,255,0.10)` | Dividers, card and table outlines |
| `--border-strong` | Control border | `#D4D4D4` | `rgba(255,255,255,0.15)` | Inputs, secondary buttons, checkboxes |
| `--accent` | Primary action | `#2272B4` | `#8ACAFF` | Primary buttons, checked controls, focus |
| `--accent-hover` | Primary action hover | `#0E538B` | `#BAE1FC` | Hover and pressed primary actions |
| `--on-accent` | Text on primary | `#FFFFFF` | `#11171C` | Labels and icons on the primary action |
| `--link` | Link | `#2272B4` | `#8ACAFF` | Inline links and tertiary actions |
| `--danger` | Validation danger | `#C82D4C` | `#F792A6` | Errors, destructive actions |
| `--success` | Validation success | `#277C43` | `#8DDDA8` | Success, healthy status |
| `--warn` | Validation warning | `#BE501E` | `#F2BE88` | Warnings, degraded status |

Status always pairs its color with an icon or a text label. Never use the validation colors decoratively.

## Typography

- **UI font:** `"Figtree Variable", system-ui, sans-serif`.
- **Code font:** `"Commit Mono", ui-monospace, monospace`.
- Figtree is on Google Fonts (`https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap`); Commit Mono is open source (commitmono.com). Fall back to `system-ui` and `ui-monospace`.
- Weights: 400 regular, 500 medium, 600 bold.

| Role | Size | Line height |
| --- | --- | --- |
| Caption / small | 12px | 16px |
| Body | 13px | 20px |
| Medium | 16px | 24px |
| Large | 20px | 28px |
| Heading | 24px | 32px |
| Title | 32px | 40px |

Use sentence case for titles, buttons and labels. Keep body text at the Body size; reach for the larger steps only for page titles and section headings.

## Layout, spacing and grid

- Spacing steps: 4, 8, 12, 16, 24 and 32px (`--space-1` … `--space-6`). Padding inside controls is 4–8px; inside cards and panels 16–24px.
- Product layout: a left navigation rail, a top bar with the page title and primary action on the right, and a content area that fills the width. Tables and lists run edge to edge inside their card.
- Controls are 32px tall by default (24px small, 40px large).
- Left-align text; right-align numbers in tables.

## Components and elevation

- **Buttons.** Primary: `--accent` fill, `--on-accent` label, radius 999px (pill). Default: `--bg` fill with a 1px `--border-strong` outline and `--fg` label. Tertiary: text-only in `--link`. Destructive: `--danger`. One primary button per view.
- **Inputs.** `--bg` field, 1px `--border-strong`, radius 4px, `--muted` placeholder; focus shows a 2px `--accent` ring.
- **Cards and panels.** `--bg` on `--surface` (or the reverse), 1px `--border`, radius 8px (small), 12px (medium), 16px (large).
- **Tables.** `--surface` header row, 1px `--border` row dividers, hover tint from `--surface`, 13–14px text.
- **Tags.** Small rounded labels on a tint of the status or neutral color with dark text.
- **Elevation.** Low elevation `0 2px 3px -1px rgb(0 0 0 / .05), 0 1px 0 0 rgb(0 0 0 / .02)` for raised controls and cards; medium `0 2px 16px 0 rgb(0 0 0 / .08)` for menus and popovers. Tinted surfaces (accent `#D7EDFE`, positive `#D4F7DF`, caution `#FCEACA`, negative `#FDE2E8`) carry selection and status.

## Do and don't

- **Do** keep screens neutral and let one primary action stand out.
- **Do** design both light and dark; use the dark values above, not inverted colors.
- **Do** keep copy short and in sentence case: "Create table", not "CREATE NEW TABLE".
- **Don't** introduce brand colors (Lava red, gradients) into product UI; this is not the marketing brand.
- **Don't** invent new font sizes or radii outside the scales above.
- **Don't** use color alone to communicate state.

## Agent prompt guide

When generating with this design system, build product UI in the dbui dbui Base theme: `--bg` canvas, `--fg` text, `--muted` secondary text, 1px `--border` dividers and a single `--accent` primary action. Use Figtree (variable) at the Body size for UI text and Commit Mono for code. Corners are 4px on controls and 999px (pill) on buttons. Prefer tables, forms, side navigation and cards over decorative layouts, and provide a dark mode with the listed dark values.
