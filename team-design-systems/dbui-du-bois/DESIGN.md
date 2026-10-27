---
name: "dbui Du Bois"
category: Product UI
surface: web
colors:
  background: "#FFFFFF"
  surface: "#F7F7F7"
  text: "#161616"
  muted: "#6F6F6F"
  border: "#EBEBEB"
  primary: "#2272B4"
---

# dbui Du Bois

> Category: Product UI
> Du Bois, the default dbui theme: the look of the Databricks product. White and near-black neutrals, Blue 600 primary actions, a dense 13px system-font type scale and 4px corners.

## Provenance and intended use

This package captures the **Du Bois** theme of dbui, the Databricks design system (`@databricks/design-system`, v2.0.15) — the theme dbui uses by default. Colors, type, radius and elevation come from that theme's published values; layout and copy guidance are OpenDesign adaptations.

Use it to mock up Databricks product screens, Databricks Apps, internal tools and dashboards in this theme. To build the real thing, use the dbui React components: `npx @databricks/design-system --theme dubois` scaffolds a project with this theme selected.

## Visual theme and atmosphere

Calm, dense and utilitarian. Content is the product: tables, editors and data dominate, chrome stays quiet. Color is functional — Blue 600 marks the primary action and links, validation colors mark state, and almost everything else is neutral.

**Key signals**

- Light mode by default, with a full dark theme (values below).
- One primary action per view, filled `#2272B4`.
- Hierarchy from text color and weight, not from extra colors.
- the system UI font stack for UI text, the system monospace stack for code and identifiers.
- Corners: controls 4px, buttons 4px.

## Color palette and roles

**Key colors (light)**

- **Page background**: `#FFFFFF`
- **Foreground text**: `#161616`
- **Primary accent**: `#2272B4`
- **Border**: `#EBEBEB`

| Token | Role name | Light | Dark | Use |
| --- | --- | --- | --- | --- |
| `--bg` | Background primary | `#FFFFFF` | `#11171C` | Page and panel canvas |
| `--surface` | Background secondary | `#F7F7F7` | `#1F272D` | Sidebars, table headers, recessed and selected areas |
| `--fg` | Text primary | `#161616` | `#E8ECF0` | Body text, headings, icons |
| `--muted` | Text secondary | `#6F6F6F` | `#92A4B3` | Descriptions, metadata, placeholders |
| `--border` | Border | `#EBEBEB` | `#1F272D` | Dividers, card and table outlines |
| `--border-strong` | Control border | `#CBCBCB` | `#37444F` | Inputs, secondary buttons, checkboxes |
| `--accent` | Primary action | `#2272B4` | `#4299E0` | Primary buttons, checked controls, focus |
| `--accent-hover` | Primary action hover | `#0E538B` | `#8ACAFF` | Hover and pressed primary actions |
| `--on-accent` | Text on primary | `#FFFFFF` | `#FFFFFF` | Labels and icons on the primary action |
| `--link` | Link | `#2272B4` | `#4299E0` | Inline links and tertiary actions |
| `--danger` | Validation danger | `#C82D4C` | `#E65B77` | Errors, destructive actions |
| `--success` | Validation success | `#277C43` | `#3BA65E` | Success, healthy status |
| `--warn` | Validation warning | `#BE501E` | `#DE7921` | Warnings, degraded status |

Status always pairs its color with an icon or a text label. Never use the validation colors decoratively.

## Typography

- **UI font:** `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`.
- **Code font:** `ui-monospace, SFMono-Regular, Menlo, monospace`.
- System fonts; nothing to load.
- Weights: 400 regular, 600 bold.

| Role | Size | Line height |
| --- | --- | --- |
| Caption / small | 12px | 16px |
| Body | 13px | 20px |
| Large | 18px | 24px |
| Heading | 22px | 28px |
| Title | 32px | 40px |

Use sentence case for titles, buttons and labels. Keep body text at the Body size; reach for the larger steps only for page titles and section headings.

## Layout, spacing and grid

- Spacing steps: 4, 8, 12, 16, 24 and 32px (`--space-1` … `--space-6`). Padding inside controls is 4–8px; inside cards and panels 16–24px.
- Product layout: a left navigation rail, a top bar with the page title and primary action on the right, and a content area that fills the width. Tables and lists run edge to edge inside their card.
- Controls are 32px tall by default (24px small, 40px large).
- Left-align text; right-align numbers in tables.

## Components and elevation

- **Buttons.** Primary: `--accent` fill, `--on-accent` label, radius 4px. Default: `--bg` fill with a 1px `--border-strong` outline and `--fg` label. Tertiary: text-only in `--link`. Destructive: `--danger`. One primary button per view.
- **Inputs.** `--bg` field, 1px `--border-strong`, radius 4px, `--muted` placeholder; focus shows a 2px `--accent` ring.
- **Cards and panels.** `--bg` on `--surface` (or the reverse), 1px `--border`, radius 4px (inputs, small cards), 8px (cards, panels), 12px (dialogs).
- **Tables.** `--surface` header row, 1px `--border` row dividers, hover tint from `--surface`, 13–14px text.
- **Tags.** Small rounded labels on a tint of the status or neutral color with dark text.
- **Elevation.** Flat surfaces separated by 1px borders. Menus, popovers and dialogs use `0 4px 16px rgba(31,39,45,.12)`; the highest layers use `0 8px 24px rgba(31,39,45,.2)`.

## Do and don't

- **Do** keep screens neutral and let one primary action stand out.
- **Do** design both light and dark; use the dark values above, not inverted colors.
- **Do** keep copy short and in sentence case: "Create table", not "CREATE NEW TABLE".
- **Don't** introduce brand colors (Lava red, gradients) into product UI; this is not the marketing brand.
- **Don't** invent new font sizes or radii outside the scales above.
- **Don't** use color alone to communicate state.

## Agent prompt guide

When generating with this design system, build product UI in the dbui Du Bois theme: `--bg` canvas, `--fg` text, `--muted` secondary text, 1px `--border` dividers and a single `--accent` primary action. Use the system UI font stack at the Body size for UI text and the system monospace stack for code. Corners are 4px on controls and 4px on buttons. Prefer tables, forms, side navigation and cards over decorative layouts, and provide a dark mode with the listed dark values.
