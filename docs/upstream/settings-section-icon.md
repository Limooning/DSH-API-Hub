# Feature request: let `settings.section` provide its own nav icon

> Ready to paste into the DeepSeek Harness issue tracker.

## Problem

A third-party plugin that registers a settings section always shows the generic
gear in the settings navigation. There is no way for the plugin to supply its
own glyph, even though the same plugin can render an arbitrary icon in the
sidebar (`sidebar.panellist` takes a component).

This is only cosmetic, but it makes third-party sections indistinguishable at a
glance and forces plugins that care about branding to also register a sidebar
panel just to show a logo.

## Where it happens

`@deepseek-ai/dsh-client-ui-settings-general` (`lib/client.js`) resolves the nav
glyph from the section id:

```js
/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id) {
  if (id === "account") return jsx(IconUserOutlineMedium, { ... });
  if (id === "models") return jsx(IconDataOutlineMedium, { ... });
  if (id === "agent-presets") return jsx(IconAgentPresetOutlineMedium, { ... });
  if (id === "plugins") return jsx(IconPersonalizationOutlineMedium, { ... });
  if (id === "archived-sessions") return jsx(IconArchiveOutlineMedium, { ... });
  return jsx(IconSettingsOutlineMedium, { ... });   // every third-party section
}
```

and renders the row as:

```jsx
{ navIcon(row.id), <span className={styles.navLabel}>{row.label}</span> }
```

The section registration only accepts `id`, `order`, `label` (and `locale` /
`inject`), so a plugin cannot opt out of the fallback.

## Proposal

Accept an optional `icon` on the `settings.section` registration:

```js
ctx.slots.register({
  name: "settings.section",
  id: "api-hub",
  order: 60,
  label: () => "API Hub",
  icon: ({ size }) => h(MyGlyph, { size }),   // NEW: component, same shape as
}, SectionComponent);                          // sidebar.panellist's glyph
```

Resolution order: `registration.icon` → `navIcon(id)` → gear. Sizes and
className should keep coming from the shell (16px, `styles.navIcon`), so the
plugin only draws paths.

Alternative (smaller surface): accept an icon **name** from the primitives set,
e.g. `icon: "data"`, `icon: "user"`, `icon: "archive"`, with the gear as the
default. That avoids passing components across the slot boundary but still
needs a curated list.

## Why not reuse `sidebar.panellist`

The sidebar's glyph slot is keyed by panel id and only *draws* the glyph — the
row itself comes from the shell's panel store. A sidebar entry is not a
substitute for a settings section: many users open settings without ever using
the sidebar, and a plugin should not have to register a second surface purely to
show a logo.

## Compatibility

- Existing sections keep their current glyphs (`navIcon` still runs when no
  `icon` is given).
- Unknown ids keep falling back to the gear, so nothing breaks for plugins that
  ship before this lands.
- No change to the slot's render props; the icon is metadata consulted by the
  shell.

## Workaround we use today

We register both a settings section (gear) and a sidebar seat
(`sidebar.panellist` + `main`) so the plugin at least has a branded entry
somewhere. The settings nav still shows the gear.
