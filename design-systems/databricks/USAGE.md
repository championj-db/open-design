# Databricks Usage

Agent-facing guide for the Databricks brand package.

## Read Order

1. Read this file for the package contract and the source boundary.
2. Read `DESIGN.md` for the palette and its roles, typography, layout, components, data visualization, logo and voice rules.
3. Paste the complete `tokens.css` into the first artifact `<style>` block, and load DM Sans and DM Mono from Google Fonts, before writing component CSS.
4. Read `components.manifest.json` for the compact inventory, then inspect `components.html` when selectors or states matter.
5. Use the `preview/` pages for quick color, typography and spacing checks.
6. Consult `source/evidence.md` before claiming that a value is an official Databricks specification.

## Design Highlights

- Oat Light (`#F9F7F4`) canvas, White cards, Oat Medium bands, and Navy 800 (`#1B3139`) text or full-bleed dark sections.
- Lava 600 (`#FF3621`) is the single accent per view: the primary action, a key figure, one highlighted phrase.
- DM Sans for all text and DM Mono for code; sizes on the 8-point scale (12, 16, 20, 24, 32, 40, 56, 64) with 120% headline and 150% body line height.
- A 12-column grid with generous whitespace: few elements per view, in two- and three-column and card layouts.
- Charts use the brand series order exposed as `--db-chart-1` … `--db-chart-8`, highlighting one series in Lava.
- `data-theme="dark"` switches to Navy 900/800 surfaces with Oat text.

## Do

- Choose semantic tokens (`--bg`, `--fg`, `--accent`, …) and use `--db-*` extensions only for the extended palette and charts.
- Keep Lava 600 buttons at 16px weight 500+ with white text; use Lava 700 (`--accent-hover`) where small text needs AA contrast.
- Write direct, clear, smart, approachable copy: short titles, scannable hierarchy, explicit calls to action.
- Use official Databricks logo files and icons; keep clear space of at least the wordmark's "a" width.
- Label chart series directly and pair status color with text.

## Avoid

- Avoid using Lava as a background wash, for body text, or for more than one emphasis per view.
- Avoid gradients, glows, 3D effects, generic orange or the Du Bois product red in place of Lava.
- Avoid fonts other than DM Sans and DM Mono, right-aligned text, and crowded layouts.
- Avoid recreating, recoloring or distorting the logo; this package ships no logo files.
- Avoid treating the values marked "adaptation" in `tokens.css` as official brand specifications.
- Avoid editing `components.manifest.json` by hand; it is derived from `components.html` and `tokens.css`.
