# Databricks

> Category: Developer Tools
> The Databricks Data Intelligence Platform brand: Lava 600 red and Navy 800 on Oat and White neutrals, DM Sans and DM Mono type, an 8-point grid, and direct, clear, smart, approachable copy.

## Provenance and intended use

This package follows the Databricks 2025 corporate brand system as published in the [Databricks Extended Brand Guidelines](https://brandguides.brandfolder.com/databricks-extended-brand-guidelines) and the 2025 corporate slide template. Product-UI details (radius, shadows, compact type) come from Du Bois, Databricks' product design system, as it appears in the public [`databricks/app-templates`](https://github.com/databricks/app-templates) stylesheet.

Use it for Databricks-branded marketing pages, solution briefs, customer-facing decks, Databricks Apps, dashboards and internal tools. The brand palette, fonts and type scale are brand-sourced. Values the brand does not publish — the 14px dense size, display tracking, radius steps and motion — are OpenDesign adaptations and are marked as such in `tokens.css`. Do not cite them as Databricks specifications.

Logos are not bundled. Use the official lockups from the Databricks brand portal and never recreate the brick symbol or wordmark.

## Visual theme and atmosphere

Databricks looks confident, technical and warm. Most surfaces are light: Oat Light (`#F9F7F4`) as the canvas, White (`#FFFFFF`) for cards, and Oat Medium (`#EEEDE9`) for alternate bands. Navy 800 (`#1B3139`) carries text, and also whole sections when a dark, high-impact treatment is wanted. Lava 600 (`#FF3621`) is the signature accent: calls to action, key numbers, one highlighted word, the active state. It is never wallpaper.

The look is restrained and editorial: generous whitespace, a 12-column grid, short headlines and few elements per view ("less is more"; don't cram content). Depth comes from surface contrast — Oat against White against Navy — more than from shadows. Diagrams and product screenshots do the visual heavy lifting; decoration is minimal.

**Key signals**

- Oat Light canvas with Navy text; never pure-white-on-gray "generic SaaS".
- Exactly one Lava accent per view, usually the primary action.
- Navy (800/900) full-bleed sections for emphasis, quotes and dark layouts.
- DM Sans everywhere, DM Mono for code and technical labels.
- Sizes on the 8-point scale: 12, 16, 20, 24, 32, 40, 56, 64.

## Color palette and roles

### Primary palette

The primary brand colors are Lava 600, Navy 800, Oat Medium, Oat Light and White.

| Token | Brand name | Hex | Role |
| --- | --- | --- | --- |
| `--accent` | Lava 600 | `#FF3621` | Primary actions, highlights, key figures |
| `--fg` | Navy 800 | `#1B3139` | Text, dark sections |
| `--surface-warm` | Oat Medium | `#EEEDE9` | Alternate bands, recessed panels, table headers |
| `--bg` | Oat Light | `#F9F7F4` | Page canvas |
| `--surface` | White | `#FFFFFF` | Cards, inputs, popovers |

### Secondary palette and grays

| Token | Brand name | Hex | Role |
| --- | --- | --- | --- |
| `--db-lava-500` | Lava 500 | `#FF5F46` | Secondary red, dark-mode hover |
| `--db-navy-900` | Navy 900 | `#0B2026` | Deepest navy, dark canvas |
| `--danger` / `--db-maroon-600` | Maroon 600 | `#98102A` | Errors, destructive actions |
| `--warn` / `--db-yellow-600` | Yellow 600 | `#FFAB00` | Warnings, attention |
| `--success` / `--db-green-600` | Green 600 | `#00A972` | Success, healthy status |
| `--db-blue-600` | Blue 600 | `#2272B4` | Links in product UI, focus rings, info |
| `--fg-2` | Gray – Navigation | `#303F47` | Navigation, secondary headings |
| `--muted` | Gray – Text | `#5A6F77` | Body copy on light, captions |
| `--border` | Gray – Lines | `#DCE0E2` | Dividers, outlines, table rules |

### Extended palette

Tints and shades for hierarchy and data visualization (from the extended guidelines):

| Family | 800 | 700 | 600 | 500 | 400 | 300 |
| --- | --- | --- | --- | --- | --- | --- |
| Lava | `#801C17` | `#BD2B26` | `#FF3621` | `#FF5F46` | `#FF9E94` | `#FABFBA` |
| Navy | `#1B3139` | `#143D4A` | `#1B5162` | `#618794` | `#90A5B1` | `#C4CCD6` |
| Maroon | `#4A121A` | `#730D21` | `#98102A` | `#AB4057` | `#BF7080` | `#D69EA8` |
| Yellow | `#7D5319` | `#BA7B23` | `#FFAB00` | `#FCBA33` | `#FFCC66` | `#FFDB96` |
| Green | `#095A35` | `#00875C` | `#00A972` | `#42BA91` | `#70C4AB` | `#9ED6C4` |
| Blue | `#04355D` | `#0E538B` | `#2272B4` | `#4299E0` | `#8ACAFF` | `#BAE1FC` |

Navy also has a 900 step, `#0B2026`. The 2025 corporate template names `#1B3139` Navy 800 and `#0B2026` Navy 900, and this package follows it; one extract of the extended guide shifts the navy names by one step, so cite the hex values rather than the step numbers when it matters.

The primary colors dominate: backgrounds are Navy or Oat, Lava/Yellow/Green/Blue are accents, and the grays are for text and lines. Use tints intentionally for hierarchy and avoid low-contrast pairings.

**Contrast note.** White on Lava 600 measures about 3.6:1, which passes WCAG AA only for large or bold text (≥ 18.66px bold / 24px regular). Keep Lava 600 buttons at 16px+ weight 500–700 with white text. For small text on red, or wherever strict AA is required, fill with Lava 700 (`#BD2B26`, about 5.9:1) — it is also the hover state.

## Typography

- **DM Sans** is the primary typeface for headlines, body and UI.
- **DM Mono** is for code, CLI snippets, technical identifiers and code-oriented graphics.
- Load both from Google Fonts: `https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=DM+Mono:wght@400;500&display=swap`.

| Role | Size | Token | Line height |
| --- | --- | --- | --- |
| Display | 56–64px | `--text-4xl` | 1.2 |
| H1 | 40px | `--text-3xl` | 1.2 |
| H2 | 32px | `--text-2xl` | 1.2 |
| H3 | 24px | `--text-xl` | 1.2 |
| Lead / H4 | 20px | `--text-lg` | 1.5 |
| Body | 16px | `--text-base` | 1.5 |
| Dense UI (adaptation) | 14px | `--text-sm` | 1.5 |
| Caption / label | 12px | `--text-xs` | 1.5 |

Keep sizes on the brand scale (multiples of 8, with 12 and 20 as the allowed exceptions). Headlines run at about 120% line height, body at about 150%. Headings sit at weight 500–700 and body at 400; this weight mapping is an adaptation, so match the official template styles when you have them. Titles and claims use Title Case; supporting labels may be short uppercase eyebrows in DM Sans 500 or DM Mono. Never right-align text.

Inside Databricks product surfaces (Du Bois), UI text is denser: 13px base with 20px line height, headings at 18, 22 and 32px. Use `--text-sm` and `--text-base` for that density instead of inventing new sizes.

## Layout, spacing and grid

- Use a **12-column grid** with `--container-max: 1200px` and generous outer gutters.
- Spacing follows the **8-point grid** (`--space-1` 4px through `--space-12` 48px), with 12px and 20px as half-steps.
- Section rhythm: 96px desktop, 64px tablet, 48px phone.
- One idea per section. Each row has two or three columns at most; cards come in groups of three ("three-column card", "full-width card", left/right card with a diagram).
- Left-align text blocks. Center only short hero lines and power statements.

Canonical layouts from the corporate template are reusable primitives: title with author and date; section header with a short uppercase "supporting text" eyebrow; two- and three-column content with optional icon space; power-statement quote on Navy; three-up cards; left- or right-hand cards beside a diagram, table, code snippet or screenshot; full-width cards for large diagrams; tables and timelines.

## Components and elevation

- **Buttons.** The primary button is filled Lava 600 with white text, 16px weight 500, `--radius-sm` (4px), with Lava 700 on hover. The secondary button is White with a Navy text and a 1px `--border` outline, or Navy 800 filled on light sections. Only one primary button per view.
- **Links.** Navy text with an underline in marketing; Blue 600 (`#2272B4`) in product UI.
- **Cards.** White on Oat Light (or Oat Medium on White), 1px `--border`, `--radius-md`, padding 24–32px. On Navy sections use Navy 700 cards with Oat text.
- **Inputs.** White field, 1px `--border`, `--radius-sm`, Navy text, Gray – Text placeholder. Focus shows a 2px Blue 600 ring.
- **Badges.** Pill-shaped tints of the extended palette (300 fill, 700/800 text); status uses green, yellow and maroon with a text label.
- **Code.** DM Mono on Navy 900 with Oat text; inline code on Oat Medium.
- **Elevation.** Mostly flat. Use `--elev-ring` for outlines and `--elev-raised` (`0 2px 16px rgba(0,0,0,.08)`, Du Bois `lg`) only for menus, popovers and floating panels.

## Data visualization

Charts stay inside the Databricks palette. The default series order (the 8 most-used colors are `--db-chart-1`…`--db-chart-8`):

1. Navy 500 `#618794`
2. Lava 500 `#FF5F46`
3. Yellow 500 `#FCBA33`
4. Green 500 `#42BA91`
5. Maroon 500 `#AB4057`
6. Navy 300 `#C4CCD6`
7. Lava 400 `#FF9E94`
8. Green 400 `#70C4AB`
9. Then Lava 300 `#FABFBA`, Yellow 400 `#FFCC66`, Yellow 300 `#FFDB96`, Green 300 `#9ED6C4`, Maroon 400 `#BF7080`, Maroon 300 `#D69EA8`

Use Lava 600 alone to highlight the one series or bar the story is about, with the rest in Navy tints. Remove chart backgrounds and unnecessary borders; label series directly; never rely on color alone. In diagrams, label most elements in the darkest theme color, use color only to show relationships, and keep diagram text at 10–16px.

## Imagery, iconography and logo

- **Logo.** Use the horizontal lockup (brick symbol plus lowercase wordmark), or the vertical lockup only where space is tight. Clear space on every side is at least the width of the wordmark's lowercase "a". Use dark versions on Oat or White and light versions on Navy. Never recolor, distort, rotate, add effects to, mask with, or rebuild the logo. For co-branding, separate the logos from the "x" by the width of the bricks.
- **Icons.** Use the official Databricks icon library: simple, functional line icons in Navy, with Lava for a single emphasized icon. Do not mix icon styles.
- **Photography.** Authentic, candid photos of people collaborating in real, industry-specific settings, mixing close-ups and wide shots with natural depth of field. Avoid staged or generic stock imagery; brand-color duotones are allowed.
- **Illustration and diagrams.** Product architecture diagrams (lakehouse, Unity Catalog, Lakeflow, Mosaic AI, Agent Bricks) use flat Navy/Oat shapes with Lava accents, not 3D or gradients.

## Voice and content

The voice is **direct, clear, smart and approachable**. Keep copy short and scannable: short but interesting titles, hierarchy that reads at a glance, no filler, explicit calls to action. Lead with outcomes and proof — customer results, quantified impact, analyst recognition. Use Databricks product names exactly (Data Intelligence Platform, Unity Catalog, Lakeflow, Databricks SQL, Mosaic AI, Agent Bricks, Lakebase, Databricks Apps, AI/BI). Customer stories follow Challenge → Solution → Impact.

## Do and don't

**Do**

- Put Navy 800 text on Oat Light or White, and Oat/White text on Navy.
- Reserve Lava 600 for the single most important action or highlight.
- Keep type on the 8-point scale and line heights at 120% (headings) and 150% (body).
- Use DM Mono for code and technical identifiers.
- Leave whitespace; split crowded content into more sections.
- Use the official logo files and icon library.

**Don't**

- Don't use Lava as a large background, a body-text color, or for more than one emphasis per view.
- Don't substitute product red (Du Bois `#C82D4C`) or generic orange for Lava 600.
- Don't add gradients, glows, glassmorphism or 3D effects.
- Don't right-align text, cram content, or mix fonts other than DM Sans and DM Mono.
- Don't recolor, stretch, rotate or rebuild the logo.
- Don't place small white text on Lava 600; use Lava 700 instead.

## Agent prompt guide

```
Background:   #F9F7F4 (Oat Light)     Alt band: #EEEDE9 (Oat Medium)
Surface:      #FFFFFF                 Dark section: #1B3139 / #0B2026 (Navy 800/900)
Text:         #1B3139 (Navy 800)      Secondary: #303F47   Muted: #5A6F77
Lines:        #DCE0E2
Accent:       #FF3621 (Lava 600)      Hover: #BD2B26 (Lava 700)
Success/Warn/Danger: #00A972 / #FFAB00 / #98102A    Link (product): #2272B4
Fonts:        DM Sans (all text), DM Mono (code)
Sizes:        12 16 20 24 32 40 56 64 px; headings 1.2, body 1.5
Grid:         12 columns, 8-point spacing, 4px button radius
```

Example brief: "A Databricks-branded landing section: Oat Light canvas, a 56px DM Sans headline in Navy 800 with one key phrase in Lava 600, a 20px lead in Gray – Text, one Lava 600 primary button (white 16px/500 text, 4px radius) and a White secondary button with a Gray – Lines outline, then three White cards on a 12-column grid, and a full-bleed Navy 800 power-statement band."
