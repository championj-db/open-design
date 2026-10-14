# Databricks Source Evidence

## Source Scope

This package is curated from Databricks' own brand system. It ships no Databricks logos, fonts, photography or icon files. DM Sans and DM Mono are open-source Google Fonts and are loaded from Google Fonts, not vendored.

## Evidence Map

| Package guidance | Source |
| --- | --- |
| Primary palette (Lava 600, Navy 800, Oat Medium, Oat Light, White) and the secondary palette and grays, with hex values | Databricks 2025 corporate slide brand template (internal), consistent with the [Extended Brand Guidelines — Colors](https://brandguides.brandfolder.com/databricks-extended-brand-guidelines/colors) |
| Extended tints and shades (300–800) | [Extended Brand Guidelines — Colors](https://brandguides.brandfolder.com/databricks-extended-brand-guidelines/colors) |
| DM Sans and DM Mono, line heights, no right alignment | [Extended Brand Guidelines — Typography](https://brandguides.brandfolder.com/databricks-extended-brand-guidelines/typography) |
| Type sizes in multiples of 8 (plus 12 and 20), 12-column grid, "less is more" | Databricks corporate slide templates (internal) |
| Default chart series order | Databricks corporate slide template (internal) |
| Logo lockups, clear space, colorways and misuse; photography; icons | [Extended Brand Guidelines](https://brandguides.brandfolder.com/databricks-extended-brand-guidelines) |
| Product radius (4px base), shadows, dense 13/20px UI text | Du Bois tokens as used in the public [`databricks/app-templates`](https://github.com/databricks/app-templates) chatbot template stylesheet |
| Voice: direct, clear, smart, approachable | Databricks visual-content and writing guidance (internal) |

## Adaptation Boundary

`tokens.css` comments name the brand source of each value. OpenDesign's shared token schema also requires slots that the brand does not publish; those are filled with OpenDesign adaptations: the 14px dense size, display tracking, the radius steps above 4px, motion timing, container width and gutters, focus ring, and the dark-theme semantic mapping. They are marked "adaptation" in `tokens.css` and in `DESIGN.md`, and should not be cited as Databricks specifications. Minimum logo size and exact per-role font weights were not available in the sources and are not specified. The component fixture is original OpenDesign markup.
