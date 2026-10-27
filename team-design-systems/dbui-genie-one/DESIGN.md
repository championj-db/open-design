---
name: "dbui Genie One"
category: Product UI
surface: web
colors:
  background: "#FFFFFF"
  surface: "#EBEBEB"
  text: "#161616"
  muted: "#6F6F6F"
  border: "#EBEBEB"
  primary: "#161616"
---

# dbui Genie One

> Category: Product UI
> Genie One, the dbui theme of the Databricks One consumer shell and Genie chat: Du Bois colors with DM Sans and DM Mono, a roomier 15px type scale, near-black pill buttons and blue checked controls in dark mode.

## Provenance and intended use

This package captures the **Genie One** theme of dbui, the Databricks design system (`@databricks/design-system`, v2.0.15). Colors, type, radius and elevation come from that theme's published values; layout and copy guidance are OpenDesign adaptations.

Use it to mock up Databricks product screens, Databricks Apps, internal tools and dashboards in this theme. To build the real thing, use the dbui React components: `npx @databricks/design-system --theme genie-one` scaffolds a project with this theme selected.

## Visual theme and atmosphere

Conversational and consumer-facing: more air than Du Bois, larger readable body text, rounded pill actions and a near-black primary button. Built for chat answers, generated charts and simple data apps for business users.

**Key signals**

- Light mode by default, with a full dark theme (values below).
- One primary action per view, filled `#161616`.
- Hierarchy from text color and weight, not from extra colors.
- DM Sans for UI text, DM Mono for code and identifiers.
- Corners: controls 4px, buttons 9999px (pill).

## Color palette and roles

**Key colors (light)**

- **Page background:** `#FFFFFF`
- **Foreground text:** `#161616`
- **Primary accent:** `#161616`
- **Border:** `#EBEBEB`

| Token | Role name | Light | Dark | Use |
| --- | --- | --- | --- | --- |
| `--bg` | Background primary | `#FFFFFF` | `#11171C` | Page and panel canvas |
| `--surface` | Background secondary | `#EBEBEB` | `#37444F` | Sidebars, table headers, recessed and selected areas |
| `--fg` | Text primary | `#161616` | `#E8ECF0` | Body text, headings, icons |
| `--muted` | Text secondary | `#6F6F6F` | `#92A4B3` | Descriptions, metadata, placeholders |
| `--border` | Border | `#EBEBEB` | `rgba(255,255,255,0.06)` | Dividers, card and table outlines |
| `--border-strong` | Control border | `#CBCBCB` | `#37444F` | Inputs, secondary buttons, checkboxes |
| `--accent` | Primary action | `#161616` | `#4299E0` | Primary buttons, checked controls, focus |
| `--accent-hover` | Primary action hover | `#424242` | `#8ACAFF` | Hover and pressed primary actions |
| `--on-accent` | Text on primary | `#FFFFFF` | `#FFFFFF` | Labels and icons on the primary action |
| `--link` | Link | `#2272B4` | `#4299E0` | Inline links and tertiary actions |
| `--danger` | Validation danger | `#C82D4C` | `#E65B77` | Errors, destructive actions |
| `--success` | Validation success | `#277C43` | `#3BA65E` | Success, healthy status |
| `--warn` | Validation warning | `#BE501E` | `#DE7921` | Warnings, degraded status |

Status always pairs its color with an icon or a text label. Never use the validation colors decoratively.

## Typography

- **UI font:** `"DM Sans", system-ui, sans-serif`.
- **Code font:** `"DM Mono", ui-monospace, monospace`.
- Both are on Google Fonts: `https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600&family=DM+Mono:wght@400;500&display=swap`.
- Weights: 400 regular, 600 bold.

| Role | Size | Line height |
| --- | --- | --- |
| Small | 14px | 20px |
| Body | 15px | 24px |
| Large | 18px | 24px |
| Heading | 20px | 32px |
| Title | 24px | 32px |

Use sentence case for titles, buttons and labels. Keep body text at the Body size; reach for the larger steps only for page titles and section headings.

## Layout, spacing and grid

- Spacing steps: 4, 8, 12, 16, 24 and 32px (`--space-1` … `--space-6`). Padding inside controls is 4–8px; inside cards and panels 16–24px.
- Product layout: a left navigation rail, a top bar with the page title and primary action on the right, and a content area that fills the width. Tables and lists run edge to edge inside their card.
- Controls are 32px tall by default (24px small, 40px large).
- Left-align text; right-align numbers in tables.

## Components and elevation

- **Buttons.** Primary: `--accent` fill, `--on-accent` label, radius 9999px (pill). Default: `--bg` fill with a 1px `--border-strong` outline and `--fg` label. Tertiary: text-only in `--link`. Destructive: `--danger`. One primary button per view.
- **Inputs.** `--bg` field, 1px `--border-strong`, radius 4px, `--muted` placeholder; focus shows a 2px `--accent` ring.
- **Cards and panels.** `--bg` on `--surface` (or the reverse), 1px `--border`, radius 8px (cards), 12px (dialogs and the chat composer).
- **Tables.** `--surface` header row, 1px `--border` row dividers, hover tint from `--surface`, 13–14px text.
- **Tags.** Small rounded labels on a tint of the status or neutral color with dark text.
- **Elevation.** Mostly flat; the chat composer and floating panels lift with a soft shadow (`0 2px 16px rgba(0,0,0,.08)`). Strong surfaces (`#EBEBEB` light, `#37444F` dark) mark user messages and selected items.

## Do and don't

- **Do** keep screens neutral and let one primary action stand out.
- **Do** design both light and dark; use the dark values above, not inverted colors.
- **Do** keep copy short and in sentence case: "Create table", not "CREATE NEW TABLE".
- **Don't** introduce brand colors (Lava red, gradients) into product UI; this is not the marketing brand.
- **Don't** invent new font sizes or radii outside the scales above.
- **Don't** use color alone to communicate state.

## Agent prompt guide

When generating with this design system, build product UI in the dbui Genie One theme: `--bg` canvas, `--fg` text, `--muted` secondary text, 1px `--border` dividers and a single `--accent` primary action. Use DM Sans at the Body size for UI text and DM Mono for code. Corners are 4px on controls and 9999px (pill) on buttons. Prefer tables, forms, side navigation and cards over decorative layouts, and provide a dark mode with the listed dark values.
