---
name: Gluon
description: Your home server, at a glance. A traditional app shell whose state language is drawn like an instrument plate.
colors:
  ground: "#f4f3ef"
  panel: "#fdfcfa"
  panel-2: "#f9f8f5"
  sunk: "#ebeae5"
  line: "#dddbd4"
  line-strong: "#c7c4bb"
  ink: "#18181a"
  ink-2: "#45443f"
  muted: "#6b6962"
  faint: "#9a978e"
  attn: "#d49b12"
  attn-strong: "#b8860b"
  attn-soft: "#f8edcd"
  attn-ink: "#1c1500"
  fault: "#b93a26"
  fault-soft: "#f7e3dd"
  ok: "#2f6e49"
  ok-soft: "#e1eee5"
  info: "#2d5f8f"
  ground-dark: "#111214"
  panel-dark: "#17181b"
  panel-2-dark: "#1b1c20"
  sunk-dark: "#0c0d0e"
  line-dark: "#26272b"
  line-strong-dark: "#36373c"
  ink-dark: "#ece7db"
  ink-2-dark: "#bdb8ac"
  muted-dark: "#918d83"
  faint-dark: "#6a675f"
  attn-dark: "#f2c14e"
  attn-strong-dark: "#f5cd6b"
  attn-soft-dark: "#2e2715"
  attn-ink-dark: "#1a1400"
  fault-dark: "#f07a62"
  fault-soft-dark: "#3a1d17"
  ok-dark: "#86c49a"
  ok-soft-dark: "#16261c"
  info-dark: "#8fb8de"
typography:
  display:
    fontFamily: "Special Gothic, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 2.75rem)"
    fontWeight: 480
    lineHeight: 1.02
    letterSpacing: "-0.015em"
    fontVariation: "'wdth' 76"
  headline:
    fontFamily: "Special Gothic, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 540
    lineHeight: 1.02
    letterSpacing: "-0.012em"
    fontVariation: "'wdth' 80"
  figure:
    fontFamily: "Special Gothic, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 520
    lineHeight: 1.05
    fontFeature: "'tnum' 1"
    fontVariation: "'wdth' 80"
  title-section:
    fontFamily: "Special Gothic, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
    fontVariation: "'wdth' 90"
  title:
    fontFamily: "Radio Canada, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 620
    lineHeight: 1.3
  summary:
    fontFamily: "Radio Canada, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
    fontVariation: "'wdth' 96"
  body:
    fontFamily: "Radio Canada, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
    fontVariation: "'wdth' 96"
  body-sm:
    fontFamily: "Radio Canada, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Special Gothic, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.16em"
    fontVariation: "'wdth' 85"
  mono:
    fontFamily: "Atkinson Hyperlegible Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.92em"
    fontWeight: 400
rounded:
  hairline: "3px"
  small: "5px"
  item: "6px"
  control-sm: "7px"
  control: "8px"
  popup: "10px"
  panel: "12px"
  dialog: "14px"
  sheet: "16px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "20px"
  space-6: "24px"
  space-8: "32px"
  space-10: "40px"
  space-12: "48px"
  control-sm: "28px"
  control: "34px"
  row: "44px"
  gutter: "40px"
  gutter-phone: "16px"
  sidebar: "236px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.panel}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "{spacing.control}"
    typography: "{typography.title}"
  button-primary-hover:
    backgroundColor: "color-mix(in oklab, #18181a 86%, #f4f3ef)"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "{spacing.control}"
  button-secondary-hover:
    backgroundColor: "{colors.panel-2}"
  button-remedy:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control-sm}"
    padding: "0 10px"
    height: "{spacing.control-sm}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "{spacing.control}"
  button-danger:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.fault}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "{spacing.control}"
  button-danger-hover:
    backgroundColor: "{colors.fault-soft}"
  button-danger-solid:
    backgroundColor: "{colors.fault}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "{spacing.control}"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "{spacing.control}"
  segmented:
    backgroundColor: "{colors.sunk}"
    rounded: "9px"
    padding: "3px"
  segmented-active:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.item}"
    padding: "0 12px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "16px 18px"
  panel-head:
    typography: "{typography.title}"
    padding: "10px 18px"
    height: "50px"
  nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control-sm}"
    padding: "0 10px"
    height: "{spacing.control}"
  nav-link-active:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.panel}"
    rounded: "{rounded.item}"
    padding: "5px 8px"
  menu:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.popup}"
    padding: "5px"
  dialog:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    width: "520px"
  notice-attention:
    backgroundColor: "{colors.attn-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.popup}"
    padding: "12px 14px"
  notice-fault:
    backgroundColor: "{colors.fault-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.popup}"
    padding: "12px 14px"
  table-row:
    backgroundColor: "{colors.panel}"
    height: "60px"
    padding: "0 14px 0 18px"
  table-row-hover:
    backgroundColor: "{colors.panel-2}"
  usage-track:
    backgroundColor: "{colors.sunk}"
    rounded: "3px"
    height: "6px"
  usage-fill:
    backgroundColor: "{colors.ink-2}"
  usage-fill-attention:
    backgroundColor: "{colors.attn}"
---

# Design System: Gluon

## Overview

**Creative North Star: "The Instrument Plate"**

Gluon is a traditional app shell (sidebar, pages, tables, panels) whose state is drawn the way a bench instrument draws a signal. Every container on the server is a 2px hairline in a live spectrum; whether it is healthy is carried by the form of that line, not by a coloured badge. The grounds are bone by day and graphite under a lamp by night, the ink is near-black or warm parchment, and one sodium-yellow colour is held back for a single meaning: something needs you.

The system is quiet on purpose so that the one loud thing reads instantly. Hierarchy comes from the width axis of Special Gothic and Radio Canada (condensed headings and figures, open body), from tracked micro-caps labels, and from 1px rules, not from fills, gradients or shadows. Density is that of a working tool: 44px rows, 34px controls, a 40px gutter, with a compact mode for people who want more on screen. Every page opens with state in one plain sentence, then the cause, then the remedy one click away.

The build refuses the dark card-grid dashboard with coloured pill badges: no pills, no glass, no decorative gradients, no glowing accents.

**Key Characteristics:**
- Warm achromatic plate (bone or graphite) with hairline rules; colour is rationed by meaning.
- State as line form: solid, dashed, short red, faint, doubled sodium.
- Special Gothic (a news gothic, cut like an engraved placard) at 76–92% width for headings, figures and micro-caps labels; Radio Canada (a humanist grotesque made for a public broadcaster) at 94–96% for body and buttons.
- Tabular figures wherever a number updates; Atkinson Hyperlegible Mono for paths, ports and commands.
- Flat panels; shadows only on things that float.
- Short damped motion on `--ease-out`, 150–250 ms, with the command palette deliberately still.

## Colors

A warm neutral plate in two themes, one attention colour that means only "needs you", and a fault red that never appears without a glyph.

### Primary
- **Graphite Ink** (ink / ink-dark): the working colour. Body text, headings, the running state line, primary buttons, the active tab indicator, the focus ring (2px solid, 2px offset). In dark mode it becomes a warm parchment so text reads as lamplight, not screen white.
- **Sodium** (attn, attn-strong, attn-soft, attn-ink; with -dark variants): the "needs you" signal. The doubled state line, the doubled mark in front of a needs-you count, the attention Notice wash (attn-soft), the announcement bar, and a usage-bar fill that has crossed its threshold. People can swap it for orange, magenta or cyan in Settings for colour vision; every swap redefines the same four tokens in both themes.

### Secondary
- **Fault Red** (fault, fault-soft): something is broken. Always paired with a glyph (the short red line, the 5px rotated diamond before a field error, the short sidebar mark) or with words. Danger buttons use it as text over a tinted border; destructive confirmations may fill with it.

### Tertiary
- **Settled Green** (ok, ok-soft) and **Signal Blue** (info): code-surface colours only. They tint diff insertions and syntax tokens in the compose editor and map ANSI green and blue in log viewers. They never carry product state; running is ink, not green.

### Neutral
- **Bone / Graphite Ground** (ground / ground-dark): the page and the sidebar. Sticky bars in the page flow sit on ground or panel, solid.
- **Plate** (panel / panel-dark): panels, tables, inputs, menus, dialogs, secondary buttons. `--inverse` equals the opposite plate and is used for text on ink.
- **Plate Raised** (panel-2 / panel-2-dark): row hover, sticky day headers, affix segments.
- **Sunk** (sunk / sunk-dark): usage-bar tracks, segmented-control wells, skeletons, disabled inputs, inline code.
- **Hairline** (line / line-dark) and **Hairline Strong** (line-strong / line-strong-dark): all 1px rules and panel borders; the strong one for control borders, usage ticks and scrollbar thumbs.
- **Ink 2, Muted, Faint** (ink-2, muted, faint and dark variants): secondary text, metadata and labels, placeholders and the stopped state. A "more contrast" preference darkens muted, faint, ink-2 and both hairlines.

### Named Rules
**The Sodium Means You Rule.** `--attn` appears only where the person has to act. It is never a chart "now" marker (those are ink-2), never the text selection (that is ink at 16%), never a filled button, never decoration. Remedies next to a sodium item are outlined buttons.

**The Red Carries a Glyph Rule.** `--fault` never appears as colour alone. It rides on a short line, a diamond, a named state or a sentence, so the meaning survives for someone who cannot see red.

**The Form Before Hue Rule.** State is read from the shape of a line first and its colour second. Running is ink, not green.

## Typography

**Display Font:** Special Gothic, variable width axis 75–125 (`--font-display`; applied wherever text is condensed to 92% or less)
**Body Font:** Radio Canada at 96% width, variable width axis 75–100 (`--font-sans`)
**Mono Font:** Atkinson Hyperlegible Mono at 0.93em (with ui-monospace, SF Mono, Menlo) for paths, ports, commands, keys and values

**Character:** Two grotesques that share a width axis do all the work: the gothic engraves, the humanist reads: condensed and slightly tight for titles and big figures, the plate-engraving micro-caps for labels, open and relaxed for reading. The mono face, drawn by the Braille Institute for legibility, marks anything a person might type into a terminal and keeps 0/O and 1/l/I apart. (Mona Sans, Hubot Sans and Martian Mono were retired in 1.2: too familiar from generated interfaces.)

### Hierarchy
- **Display** (480, clamp(2rem, 3.4vw, 2.75rem), 1.02, 76% width): the Home greeting only. The Home clock goes further (68% width, up to 4.2rem, tabular).
- **Headline** (540, 34px, 1.02, 80% width): page titles; 26px under 720px.
- **Figure** (520, 28px, 1.05, 80% width, tabular): live vitals such as CPU and memory, with the unit in 14px muted at 96% width.
- **Section title** (600, 17px, 90% width) and **Title** (620, 14px): section heads and panel heads. Dialog titles are 17px at 92% width.
- **Summary** (400, 15px, 1.5, ink-2, max 70ch): the one-sentence verdict under every page title; the state words inside it go to ink at 620.
- **Body** (400, 14px, 1.45): default text. **Body small** (13px) for metadata, descriptions and field help.
- **Label** (600, 11px, 0.16em tracking, uppercase, 85% width, muted): nav group labels, vital labels, table head rows (0.14em) and spectrum callouts (0.12em). Labels name data; they never sit above a page heading.

### Named Rules
**The Width Is the Voice Rule.** Hierarchy comes from width and size, not from heavy weights. Weights stay between 450 and 650; condensing does the shouting.

**The Tabular Figures Rule.** Every number that can change uses tabular figures, so live values do not jitter.

## Layout

A fixed 236px sidebar (collapsible to a 64px icon rail) on the ground colour, and a main column capped at 1480px with a 40px gutter (28px in compact density, 16px on phones). Pages open with 28px top padding, a header of title plus summary on the left and actions on the right, 26px above the first panel.

Panels arrange in two-column grids (for example 1.25fr / 1fr on Status) that collapse to one column under 1080px. Data tables are single panels with a 38px micro-caps head row and 60px rows; under 980px they restack into two-line rows. Sections sit 36px apart; panel bodies pad 16px 18px.

Under 900px the sidebar becomes a solid top bar (56px plus the safe area) with a swipeable drawer. Under 720px rows grow to 48px for thumbs. Under 640px dialogs become bottom sheets and their footer buttons share the width.

The person controls density (comfortable or compact: rows 44 to 36px, controls 34 to 30px), text size (93.75%, 100% or 112.5% of the root) and motion (system or reduced), and all of it flows through the same tokens.

### Named Rules
**The State First Rule.** Every page is a title plus one plain sentence of state, then the cause, then the remedy. No eyebrows or kicker labels above headings, no section numbers.

## Elevation & Depth

Gluon is flat. Depth comes from the ground/plate/sunk tonal steps and 1px hairlines. Two shadow tokens exist and they belong only to layers that float above the page: menus, popovers, select lists, toasts, the chart readout, and floating action bars (Home's edit bar, the updates selection bar) take `--shadow-pop`; dialogs and the command palette take `--shadow-dialog` over a `--backdrop` scrim. Both tokens are redefined for dark mode with deeper, blacker values. The segmented control's pressed segment and the switch thumb carry a 1–2px contact shadow; that is the whole list.

### Shadow Vocabulary
- **Pop** (`--shadow-pop`): anything anchored to a trigger or floating over content.
- **Dialog** (`--shadow-dialog`): modal surfaces only.

### Named Rules
**The Only What Floats Rule.** A surface in the page flow never casts a shadow. If it does not float over other content, it is separated by a hairline and a tonal step.

**The No Glass Rule.** No backdrop blur and no translucent bars. Sticky bars (the mobile top bar, table head rows, day headers) are solid ground or panel with a hairline.

## Shapes

Gently rounded rectangles with a strict radius ladder: 12px panels, tables and toasts; 14px dialogs and the command palette (16px top corners as a phone sheet); 10px menus, popovers and notices; 8px controls; 7px small controls and nav links; 6px menu items and segments; 5px keycaps. Full rounding is reserved for the switch, the avatar and scrollbar thumbs.

Rules are 1px. State marks are 2px strokes. Keycaps get a 2px bottom border as their only relief. Empty states draw a small gluon line with one end held and the other open (nothing connected yet), in faint, instead of an illustration.

### Named Rules
**The No Pills Rule.** Nothing that carries information is a pill. Counts are plain tabular figures (12px, 600, muted); a needs-you count gets the doubled sodium mark in front of it, a fault count a short red mark.

## Brand mark and art

The mark is the curly line a Feynman diagram draws for a gluon, the particle that holds the others together, joining two points: a two-loop trochoid (x = c·t − a·sin t, y = −a·cos t) that starts and ends at a trough, with a filled dot at each end. Geometry lives in `src/components/brand/mark.ts`; `GluonMark` draws it in currentColor at glyph size. The app icon puts the coil in sodium on a graphite tile with parchment dots (the one place sodium is a brand colour rather than a signal).

Art is drawn in the same grammar, never illustrated: the sign-in plate (`BondField`) is a row of state lines held together by small gluon rungs that sketch themselves in once; the theme cards are Gluon in miniature; empty states are a gluon line with one open end. No clip art, no mascots, no gradients.

## Components

### Buttons
Quiet and exact; the label never moves.
- **Shape:** control radius, 34px tall (28px small, 42px large), 14px side padding, 560 weight at 94% width, 16px icons.
- **Primary:** ink fill with inverse text. One per view, for the main forward action.
- **Secondary (default):** plate fill, strong hairline border, ink text. This is also the remedy button beside every "Needs you" item: outlined, small, named for the action ("Make them permanent", "Free 5.2 GB").
- **Ghost:** transparent with ink-2 text, 6% ink wash on hover.
- **Danger:** fault text on a fault-tinted border, fault-soft on hover. **Danger solid** (fault fill, white text) is reserved for the final step of a destructive confirmation; the most dangerous also require hold-to-confirm (a darkening sweep over 1400ms).
- **Hover / Press / Loading:** hover changes background only, inside `(hover: hover) and (pointer: fine)`. Press scales to 0.97 over 140ms. Loading keeps the label in place at 55% opacity and sweeps a 2px hairline along the bottom edge.

### Inputs / Fields
- **Style:** plate fill, strong hairline border, control radius, 11px side padding; the label sits above in 13px 600 ink, help text below in 13px muted.
- **Focus:** border shifts to ink-2 with a 3px ring of ink at 10%.
- **Error / Disabled:** border turns fault and the message is led by a 5px fault diamond; disabled drops to 55% on the sunk colour.
- **Affix inputs** join a unit or prefix in a panel-2 segment behind a hairline. **Switches** are 34 by 20px, ink when on. **Checkboxes** are 17px at a 4px radius, ink when checked.

### Segmented control and tabs
- **Segmented:** a sunk well (9px radius, 3px padding) with 6px segments; the pressed segment lifts to plate with a hairline ring.
- **Tabs:** 40px, muted text going to ink when active, a 2px ink indicator that slides between tabs; counts follow the No Pills Rule.

### Cards / Containers (Panel)
- **Corner Style:** panel radius (12px).
- **Background:** plate on ground.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px hairline; the head is a 50px strip divided from the body by a hairline, title at 14px 620, meta at 13px muted on the right.
- **Internal Padding:** 16px 18px; lists inside run flush with hairlines between rows.

### Notices and toasts
Inline notices and toasts lead with a 2px mark in a 6px column: an ink line for neutral, the doubled sodium line on an attn-soft wash for attention, a short red line on fault-soft for faults, a dashed breathing line while loading.

### Navigation
- **Sidebar:** host name at 18px 600 and 86% width with its address and zone underneath; micro-caps group labels; 34px links in ink-2 with muted 17px iconoir icons at 1.5 stroke.
- **Active:** plate fill with a hairline ring (a slightly lifted graphite in dark mode), ink text, and a 2px ink rule on the rail's left edge.
- **Counts:** right-aligned tabular figures with the doubled sodium mark for "needs you".
- **Mobile:** solid top bar and a drawer that slides on `--ease-drawer` over 400ms and follows the finger.

### Command palette
640px wide, 14px radius, 54px search row at 17px, 42px options with a 28px sunk icon tile. Opened dozens of times a day, so it opens and closes with no animation.

### StateLine (signature)
The state glyph used everywhere a thing has a state: a 2px vertical line, 14px by default, with an optional label in 13px 560 ink-2.
- **Running:** solid ink.
- **Starting:** dashed ink.
- **Unhealthy:** short red, 45% of the height, sitting on the baseline.
- **Stopped:** faint (28% opacity).
- **Paused / unknown:** dotted, reduced.
- **Needs you:** doubled sodium, two 2px lines 2px apart.

Height, colour and opacity transition on `--ease-out`, so a resolved item's doubled line settles into a single one.

### Spectrum (signature)
The whole machine as a field of hairlines: one 2px line per container inside a 10px hit area, grouped by stack between 1px group rules, with the StateLine legend underneath. Hovering or focusing a line isolates it (others drop to 18%, the active one widens 1.5x), shows its name, state, CPU and memory in a readout above the field, and clicking opens it. On first appearance in a session the lines rise from the rail (520ms, 14ms stagger), the system's one authored moment.
- **Callouts:** each stack label hangs from a hairline dropped from its group edge, in micro-caps at 0.12em. Labels take up to 3 rows (Home uses 2); a label takes the first row where it clears the previous label by 28px, else the row that frees up soonest.
- **Capping:** each label is capped before the next label on its row (and hidden if under 36px), ellipsized, and backed with the panel colour so lower-row hairlines pass behind the text, never through it.
- **Overflow:** when the field scrolls sideways its edges fade over 40px on whichever side has more.

### Instruments (one per screen)
Each screen draws its main idea as a picture you can act on, in the same hairline and StateLine grammar:
- **Visitor map** (Network): Anyone → Cloudflare DNS (Direct and Through Cloudflare lanes) → router → Caddy → apps; each hop is a button whose state line opens its details.
- **Probe path and sweep** (Diagnostics → Checkup): a chain of hops that turns short red where a path breaks, with the fix under the break; the full checkup is one row of ticks per category.
- **Stack diagram** (App detail): addresses → containers (ports as sockets) → folders, joined by wires; hover traces, click acts.
- **Faceplate** (System): CPU threads as live hairlines, memory as a SegmentBar by app, every sensor on one graduated scale. **Swimlanes** (Sign-ins) draw who was connected when.
- **Space map** (Storage): a squarified treemap in 1px rules with cleanups attached to the blocks. **Partition strip** callouts hang tiny partitions' labels on hairlines.
- **Uptime traces** (Alerts), **access grid** (People), **seismograph** network widget (Home).
Shared building blocks live in `components/ui`: `SegmentBar`, `FlowSteps`, `Disclosure`, `HoldButton`, `InlineEdit`, `CopyButton`, and the `appear` fade for content replacing a skeleton. Motion scales by `--motion` (1, or 0 when reduced) so reduced motion keeps fades and drops travel.

### Charts and usage bars
Time charts draw a 1.5px ink line with a 7% area, dashed hairline grid, tabular axis labels at 10.5px, and a 1px ink-2 "now" line at the right edge; sparklines draw at 1.25px in faint or ink-2. Usage bars are 6px sunk tracks with an ink-2 fill that turns sodium past its threshold and fault when full, plus a 1px threshold tick.

### Named Rules
**The StateLine Grammar Rule.** Solid is running, dashed is starting, short red is unhealthy, faint is stopped, doubled sodium is needs you. Do not invent new state marks; use StateLine or the same geometry.

**The Bar Fill Exception Rule.** `width` is not a transition property, with one deliberate exception: small, absolutely positioned bars (usage, upload and job progress fills, and the 2px tab indicator), which sit out of flow and cannot shift anything around them.

**The Damped Settle Rule.** State transitions use `--ease-out` (cubic-bezier(0.23, 1, 0.32, 1)) at 150–250 ms. Sheets and drawers use `--ease-drawer` at 400ms. The command palette does not animate. Reduced motion, from the system or the person's own setting, collapses all of it.

## Do's and Don'ts

### Do:
- **Do** open every page with its title and one plain sentence of state, then cause, then remedy.
- **Do** show state with StateLine: solid running, dashed starting, short red unhealthy, faint stopped, doubled sodium needs you.
- **Do** keep sodium for "needs you" only, and make the remedy beside it an outlined (secondary) button that names its action.
- **Do** pair every use of fault red with a glyph or words.
- **Do** write counts as plain tabular figures, with the doubled sodium mark in front when they need the person.
- **Do** use tokens only: colours, `--radius-*`, `--control`, `--row`, `--text-*`, `--ease-out`, `--dur-*`.
- **Do** set paths, ports, commands and keys in Atkinson Hyperlegible Mono, and every changing number in tabular figures.
- **Do** keep sticky bars solid (ground or panel) with a hairline.
- **Do** put hover styles inside `(hover: hover) and (pointer: fine)` and keep transitions to 150–250 ms on `--ease-out`.

### Don't:
- **Don't** use sodium for chart "now" markers, text selection, filled buttons or decoration.
- **Don't** use pills or coloured badges for state or counts.
- **Don't** use glass, backdrop blur or translucent sticky bars.
- **Don't** show fault red as colour alone.
- **Don't** give in-flow surfaces a shadow; only floating layers take `--shadow-pop` or `--shadow-dialog`.
- **Don't** use decorative gradients; repeating gradients may only draw dashed or dotted line forms, and masks only the spectrum's edge fades.
- **Don't** place eyebrow or kicker labels above headings, or number sections.
- **Don't** transition `width` on anything except small, absolutely positioned bar fills and the tab indicator.
- **Don't** animate the command palette.
