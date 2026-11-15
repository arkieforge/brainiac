---
name: Brainiac
description: A person's record as typed notes with sources, kept by their own Claude and checked by them; quiet Workbench chrome with tactile character.
colors:
  bg: "#000000"
  bg-raised: "#0a0a0b"
  bg-input: "#111113"
  bg-hover: "#18181b"
  border: "#1f1f23"
  border-strong: "#2a2a30"
  fg: "#fafafa"
  fg-muted: "#a1a1aa"
  fg-faint: "#71717a"
  accent: "#6ea8ff"
  accent-ink: "#000000"
  ok: "#4ade80"
  warn: "#fbbf24"
  danger: "#f87171"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  prose:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, system-ui, sans-serif"
    fontSize: "13.5px"
    lineHeight: 1.6
  label:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.04em"
  mono:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace"
    fontSize: "12.5px"
    lineHeight: 1.65
rounded:
  badge: "4px"
  control: "6px"
  card: "10px"
spacing:
  gap: "12px"
  bar: "40px"
  side: "240px"
  meta: "280px"
motion:
  ease: "cubic-bezier(0.23, 1, 0.32, 1)"
  fast: "120ms"
  base: "160ms"
  spring: "linear() spring, 650ms, about 16% overshoot"
---

# Design System: Brainiac

## Overview

Workbench chrome with tactile character. The frame follows T3 Code: a bar, the record's tree on the left, one
pane, the note's fields in a rail. True black, dense, quiet, one accent; the record's values carry the screen.
Character comes from objects you can almost touch, not from glow: Pip the sticker mascot, a postage-stamp primary
button, a cardboard file box, drop frames that open as a file comes near, and stamps on a review card. Approved in
the #51 rounds (Workbench, then the tactile direction drawn from Pin UI's craft and stick-it-up's stickers).

Tokens live only in `apps/web/src/styles.css` on `:root`, exposed to Tailwind through `@theme inline`
(`bg-raised`, `text-faint`, `border-line-strong`...). `apps/web/src/motion.ts` mirrors the timing for JS.

## Colors

- **Ground**: `bg` true black. Surfaces step up one shade at a time: `bg-raised` (editor source, cards, file
  view), `bg-input` (fields, active line), `bg-hover` (selected row, hover, active nav).
- **Text**: `fg` for values and titles, `fg-muted` for prose and secondary text, `fg-faint` for labels and paths.
- **Accent** `accent` marks the one primary action on a screen (the stamp, Correct) and focus rings.
- **Meaning**: `ok` for verified, `warn` for sensitive, unchecked or held, `danger` for wrong or conflicting.
- **Art** (stickers, the file box) keeps its own colours; it is decoration, never a state.

### Named Rules

- One accent per screen, on the action the person is most likely to take.
- Colour in the UI means state. A note type gets an icon, not a colour.

## Typography

System sans at 13px for UI, 13.5px for rendered markdown, 17px semibold for a pane's title, 20 to 22px for the
overview's numbers. Mono for paths, labels, badges, keys and the markdown source. Numbers use tabular figures.

## Layout

- Bar 40px. Side 240px. Fields rail 280px. Below 1100px the editor stacks over its preview; below 760px the side
  becomes a drawer from the left, the nav shows icons only and the fields go above the body.
- Lists are rows, not cards. Cards only for one-at-a-time items (review, questions).
- Hairlines (`border`) separate regions; shadows only under art (stickers, the box) and the stamp.

## Components

- **Pip** (`Pip.tsx`): a stick-it-up sticker with a speech bubble that says one short, true thing taken from the
  record (the next step on the overview, empty and done states). Poses: detective (overview, not found), thinking
  (loading, signed out), coffee (nothing to do), rocket (review done). Never decoration without words.
- **Stamp** (`.stamp`): the primary link on a screen, a perforated postage stamp tilted 1.5deg that straightens on
  hover and thuds on press.
- **Buttons**: `bg-input` with a `border-strong` hairline; `.primary` fills with the accent; `.ghost` is bare.
  Pressing scales to 0.96; letting go springs back on `--spring`.
- **Badges**: mono 11px, 4px radius, hairline; warn-coloured for `sensitive`, `vault`, `unclassified`.
- **Keys**: icon, label, then the key in a `kbd`, with a tooltip saying what it does. Review's Correct is primary.
- **Fields rail**: name on the left (faint), value on the right in a borderless `bg-input` field; a change from
  another device rings the field once.
- **Drop zone** (`DropZone.tsx`): nested dashed frames that open outward while a file is held over them.
- **File box** (`FileBox.tsx`): Files' empty state; its folders lift when you point at it.
- **Loading** (Skullet): a page that waits keeps what it already knows (the overview's heading and tile labels,
  review's keys, a file's name and badges) and draws only the record's values and rows as still bars in
  `bg-hover`. The bars are measured from fictional sample markup, never from the record, so Skullet has nothing of a
  person's record to remember in `localStorage`. Each region is its own skeleton with a screen-reader label.
- **Status**: a dot (green live, amber offline) that pings once when the record's copy of a note moves to a new revision; on phones the dot
  alone unless offline.

## Icons

Phosphor (`@phosphor-icons/react`), one family everywhere: `regular` at rest, `fill` for the active nav item and
marks, `duotone` for note types and files, `bold` only on the primary key. `apps/web/src/icons.ts` maps note types
and file kinds to icons; add a type there, not inline.

## Libraries

One library per job, so nothing fights over styles:

| Job                                   | Library                           | Where                                        |
| ------------------------------------- | --------------------------------- | -------------------------------------------- |
| Styling                               | Tailwind v4 (theme + utilities)   | new components; tokens via `@theme inline`   |
| Springs, gestures, layout, exit       | `motion` 14                       | nav pill, row hover, review deck, ⌘K button  |
| Primitives (dialogs, tooltips, menus) | Base UI (`@base-ui/react`)        | ⌘K dialog, tooltips                          |
| Command palette                       | `cmdk`, inside the Base UI dialog | ⌘K                                           |
| Drawer                                | `vaul`                            | the side on phones                           |
| Toasts                                | `ding`                            | review results                               |
| Changing numbers                      | NumberFlow                        | overview counts, review progress             |
| Changing words                        | `torph`                           | Saving to Saved                              |
| Icons                                 | Phosphor                          | everywhere                                   |
| Stickers                              | `stick-it-up` (Pip, Kuro)         | Pip, empty and done states                   |
| List add, remove, reorder from sync   | `auto-animate`                    | overview groups, files                       |
| Loading skeletons                     | Skullet (`skullet/react`)         | overview, review and file view while waiting |

Tailwind runs without its preflight, so the markdown, PDF and Office renderers keep the browser defaults they
were built on. New primitives come from Base UI; shadcn is set up (`apps/web/components.json`, `@/` alias,
`base-nova`) for registry items, which get restyled to these tokens. Pin UI (pinui.xyz) is the reference for
tactile pieces, but it has no license, so we draw our own in its spirit rather than copying its code. For an
unusual Motion piece, swamimalode07/rare-ui's registry is approved; the npm package named `rareui` is a different
project. Plain CSS covers hovers, presses and fades; reach for `motion` for springs, gestures, layout or exit.

## Motion

- Everything answers something the person did, then stops. Nothing loops, pulses, shimmers or spins at rest; a
  CDP trace of an idle page shows no paints.
- `fast` (120ms) for hover, `base` (160ms) for enter and exit, both on `ease`. Springs (`--spring`, `SPRING`)
  overshoot a little: presses, the nav pill, the row highlight, the review card.
- Page changes are view transitions: the bar and side hold still, the pane fades up 6px, and a note's title
  morphs between the overview row, the review card and the note header.
- One highlight glides under the overview rows and the ⌘K rows; the active nav pill slides between links.
- Review is a deck: two cards peek out underneath, the top card tilts with a drag while CORRECT or SKIP fades in,
  letting go past 80px counts, and a card leaves the way it was sent. Undo flies it back in. Finishing bursts once.
- Small proofs: overview counts roll, Saving morphs into Saved, verified checks draw themselves, a field changed
  elsewhere rings once, the Live dot pings once per new revision from the record, the ⌘K button leans toward the cursor, rows stagger in
  once on load, and a note's title tightens and its path fades as you scroll (transform and opacity only).
- Loading skeletons hold still: Skullet's shimmer and pulse are off (`--skullet-animation: none` in `styles.css`),
  so no shimmer exception is needed. A skeleton gives way to the content at once, with no reveal.
- Reduced motion: `MotionConfig reducedMotion="user"` keeps fades and drops movement; CSS turns transitions,
  animations and view transitions off; hand-started animations (the burst, the Live ping, the field ring)
  check `calm()` and skip.

## Do's and Don'ts

### Do:

- Show the stored value and whether someone checked it.
- Let Pip say something true and short, from the record's own numbers.
- Keep every action reachable by a key and undoable.
- Check new screens at 1280px and 390px with the fixture record.

### Don't:

- Add a continuously repainting animation (spinners at rest, shimmer, pulse, animated gradients).
- Add glow, gradients behind text, a second accent, or card chrome around every list.
- Invent numbers for character (achievements, scores, streaks) the record doesn't store.
- Use em dashes in copy.
