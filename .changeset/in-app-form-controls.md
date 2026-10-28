---
'@nomi-ai/ui': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/renderer': patch
'@nomi-ai/voice': patch
---

feat(ui): checkboxes, sliders and number fields are drawn in the app style instead of the system look (new `Checkbox`, `Slider`, `NumberField`; `Input` picks them for `type="checkbox|range|number"`), so they follow the theme on macOS and Windows alike. Number fields get in-app step buttons that appear on hover or focus.
