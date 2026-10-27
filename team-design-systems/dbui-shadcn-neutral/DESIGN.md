---
name: "dbui shadcn neutral"
category: Product UI
surface: web
colors:
  background: "#FFFFFF"
  surface: "#F5F5F5"
  text: "#0A0A0A"
  muted: "#737373"
  border: "#E5E5E5"
  primary: "#171717"
---

# dbui shadcn neutral

> Category: Product UI
> The dbui shadcn neutral theme: dbui components dressed in the shadcn/ui neutral palette, Geist and Geist Mono, a near-black primary and 8px corners.

## Provenance and intended use

This package captures the **shadcn neutral** theme of dbui, the Databricks design system (`@databricks/design-system`, v2.0.15). Colors, type, radius and elevation come from that theme's published values; layout and copy guidance are OpenDesign adaptations.

Use it to mock up Databricks product screens, Databricks Apps, internal tools and dashboards in this theme. To build the real thing, use the dbui React components: `npx @databricks/design-system --theme shadcn` scaffolds a project with this theme selected.

## Visual theme and atmosphere

Monochrome and minimal, as in the shadcn/ui neutral theme: black and white, gray hierarchy, no brand hue. Use it when a dbui-built screen should read as a generic modern web app rather than Databricks.

**Key signals**

- Light mode by default, with a full dark theme (values below).
- One primary action per view, filled `#171717`.
- Hierarchy from text color and weight, not from extra colors.
- Geist (variable) for UI text, Geist Mono for code and identifiers.
- Corners: controls 8px, buttons 8px (large controls 10px).

## Color palette and roles

**Key colors (light)**

- **Page background:** `#FFFFFF`
- **Foreground text:** `#0A0A0A`
- **Primary accent:** `#171717`
- **Border:** `#E5E5E5`

| Token | Role name | Light | Dark | Use |
| --- | --- | --- | --- | --- |
| `--bg` | Background primary | `#FFFFFF` | `#0A0A0A` | Page and panel canvas |
| `--surface` | Background secondary | `#F5F5F5` | `#262626` | Sidebars, table headers, recessed and selected areas |
| `--fg` | Text primary | `#0A0A0A` | `#FAFAFA` | Body text, headings, icons |
| `--muted` | Text secondary | `#737373` | `#A3A3A3` | Descriptions, metadata, placeholders |
| `--border` | Border | `#E5E5E5` | `rgba(255,255,255,0.10)` | Dividers, card and table outlines |
| `--border-strong` | Control border | `#E5E5E5` | `rgba(255,255,255,0.15)` | Inputs, secondary buttons, checkboxes |
| `--accent` | Primary action | `#171717` | `#E5E5E5` | Primary buttons, checked controls, focus |
| `--accent-hover` | Primary action hover | `#303030` | `#CECECE` | Hover and pressed primary actions |
| `--on-accent` | Text on primary | `#FAFAFA` | `#171717` | Labels and icons on the primary action |
| `--link` | Link | `#171717` | `#E5E5E5` | Inline links and tertiary actions |
| `--danger` | Validation danger | `#C82D4C` | `#F792A6` | Errors, destructive actions |
| `--success` | Validation success | `#277C43` | `#8DDDA8` | Success, healthy status |
| `--warn` | Validation warning | `#BE501E` | `#F2BE88` | Warnings, degraded status |

Status always pairs its color with an icon or a text label. Never use the validation colors decoratively.

## Typography

- **UI font:** `"Geist Variable", system-ui, sans-serif`.
- **Code font:** `"Geist Mono Variable", ui-monospace, monospace`.
- Geist and Geist Mono are on Google Fonts: `https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono:wght@400;500&display=swap`.
- Weights: 400 regular, 600 bold.

| Role | Size | Line height |
| --- | --- | --- |
| Small | 12px | 16px |
| Body | 14px | 20px |
| Medium | 16px | 24px |
| Large | 20px | 28px |
| Heading | 24px | 32px |
| Title | 30px | 36px |

Use sentence case for titles, buttons and labels. Keep body text at the Body size; reach for the larger steps only for page titles and section headings.

## Layout, spacing and grid

- Spacing steps: 4, 8, 12, 16, 24 and 32px (`--space-1` … `--space-6`). Padding inside controls is 4–8px; inside cards and panels 16–24px.
- Product layout: a left navigation rail, a top bar with the page title and primary action on the right, and a content area that fills the width. Tables and lists run edge to edge inside their card.
- Controls are 32px tall by default (24px small, 40px large).
- Left-align text; right-align numbers in tables.

## Components and elevation

- **Buttons.** Primary: `--accent` fill, `--on-accent` label, radius 8px (large controls 10px). Default: `--bg` fill with a 1px `--border-strong` outline and `--fg` label. Tertiary: text-only in `--link`. Destructive: `--danger`. One primary button per view.
- **Inputs.** `--bg` field, 1px `--border-strong`, radius 8px, `--muted` placeholder; focus shows a 2px `--accent` ring.
- **Cards and panels.** `--bg` on `--surface` (or the reverse), 1px `--border`, radius 6px (small), 8px (medium), 10px (large).
- **Tables.** `--surface` header row, 1px `--border` row dividers, hover tint from `--surface`, 13–14px text.
- **Tags.** Small rounded labels on a tint of the status or neutral color with dark text.
- **Elevation.** Flat and monochrome: 1px `#E5E5E5` borders do the separating; menus and popovers use a soft `0 2px 16px rgba(0,0,0,.08)` shadow.

## Do and don't

- **Do** keep screens neutral and let one primary action stand out.
- **Do** design both light and dark; use the dark values above, not inverted colors.
- **Do** keep copy short and in sentence case: "Create table", not "CREATE NEW TABLE".
- **Don't** introduce brand colors (Lava red, gradients) into product UI; this is not the marketing brand.
- **Don't** invent new font sizes or radii outside the scales above.
- **Don't** use color alone to communicate state.

## Agent prompt guide

When generating with this design system, build product UI in the dbui shadcn neutral theme: `--bg` canvas, `--fg` text, `--muted` secondary text, 1px `--border` dividers and a single `--accent` primary action. Use Geist (variable) at the Body size for UI text and Geist Mono for code. Corners are 8px on controls and 8px (large controls 10px) on buttons. Prefer tables, forms, side navigation and cards over decorative layouts, and provide a dark mode with the listed dark values.
