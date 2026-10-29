# DiamondForge suite language

MoltenTerm, Notulia and the DiamondForge site should read as products of one company. Each app keeps its own identity.
This folder (`frontend/moltenterm-shell/suite/`) is the first cut of the shared UI kit (#658). Notulia is the reference
because its identity is the most finished: `src/index.css` (`.glow-ring`, the radius scale),
`components/SettingsFieldset.tsx` and `components/settings/SettingsShared.tsx`.

## Shared principles (the suite)

- **Sharp editorial corners.** Radii from 2 to 4 px: 4 px for blocks, icon tiles and dialogs, 3 px for chips, pockets
  and toggles, 2 px for the smallest marks. `rounded-full` is kept for dots, radios, switches and pills.
- **Section blocks, not floating headings.** A group of settings is a framed block. Its name is an uppercase chip sunk
  halfway into the top border. The border dives around the chip in a small pocket, and the block's icon sits in an
  accent tile on the top-left corner. One line of description comes first, then the rows, flush with the block's
  edges and divided by hairlines.
- **The label chip.** 24 px high, 11 px semibold uppercase, 0.08 em tracking, filled with the accent (a top-to-bottom
  fade to 85 %), with a soft accent shadow. The same chip is the active tab when a block holds tabs.
- **Option rows for short exclusive choices.** A radio, an optional icon, the label, and "Selected" in the accent on
  the right. The selected row gets a 7 % accent wash. Every choice stays in sight, so no menu is needed for four
  choices or fewer.
- **Toggle groups.** Separate bordered rectangles. The chosen one is outlined in the accent rather than filled.
- **The turning light.** A highlighted frame (an open dialog, the block a link or a search lands on) carries a soft
  light that travels around its border: a conic gradient on a 1 px ring, one turn in 8 s. The light only shows while
  the frame is highlighted. Under reduced motion it stands still on the top-right corner.
- **One accent.** Each app has a single accent that does all the colouring. The chrome stays nearly neutral.
- **One icon set.** Lucide, one icon per concept (`suite-icons.ts`). A concept Notulia already draws keeps Notulia's
  icon. A concept only MoltenTerm has is marked `proposed` until the kit settles it.
- **Flat surfaces.** Hairline borders, no gradients on cards, no heavy shadows. Depth comes from the border and the
  accent, not from elevation.

## What stays MoltenTerm

- **The accent is the action** (#1319): molten orange in every workspace (`--mt-action`, aliased `--mt-accent`).
  `--df-accent` maps to it, so a block's chip and tile look the same in every workspace, like the molten buttons. The
  workspace colour (`--mt-place`) marks the place only: the workspace dot, the sidebar strip, the bar beside the
  workspace name, the active tile's underline and the focused panel's frame.
- **Its fonts and type scale.** Rows use 12 px and descriptions 12 px (`--mt-text-*`); Notulia uses 14 px. The kit
  reads them through `--df-text-*`.
- **Its warm neutrals** (`--mt-surface-*`, `--mt-line-*`, `--mt-text-*`), the terminal's dark theme, and the
  `molten-btn` call to action with its wave. The kit has no button of its own: each app keeps its call to action.
- **Its density.** Rows of 28/32 px elsewhere in the shell, and the terminal stays black.
- **Its motion tokens.** The kit's durations map onto `--mt-duration-*`, so MoltenTerm's reduced-motion setting stops
  the kit as well.

MoltenTerm has no light theme today. The kit ships Notulia's light set under `.df-light` / `[data-df-theme="light"]`,
so a future light theme only has to map the same slots.

## Using the kit in MoltenTerm

- Components (`suite.tsx`): `SectionBlock` (title chip, `icon`, `description`, `footer` straddling the bottom border,
  `glow`, `tone="danger"`, `titleCase="as-is"`), `BlockRows`, `OptionList` + `OptionRow`, `RadioDot`, `ToggleGroup`,
  `GlowRing`, `SuiteSignature` (the "MoltenTerm 1.0.0 · A DiamondForge product" line, #740: the app passes its name,
  version and translated label; it sits only in quiet places, the end of Settings' sidebar and under the version in
  the version history, never in the status bar or the tab bar).
- Icons: `suiteIcon("language")` and the other concepts in `suite-icons.ts`. Use named imports from `lucide-react`
  only.
- The mapping of the `--df-*` slots lives in `../tokens.css`. The token lint (`build/token-lint.ts`) accepts
  `var(--df-text-*)`, `var(--df-weight-*)` and `var(--df-duration-*)`. The build's radius cap (`build/cap-radius.ts`)
  leaves `--df-radius-*` alone.
- Applied in #658 to Settings (every group, Secrets, Mods, Advanced files and Keyboard) and the workspace editor
  (Identity, Project, Folder, Danger zone, and the dialog frame through `DialogFrame suite`). Tips follows through
  `PageCard`. Since #890 every `DialogFrame` carries the turning light while it is open (`noGlow` opts out, with the
  reason written at the call site); `suite` only adds the room its section blocks need.
- Since #905 every dialog is framed this way: MoltenTerm's own through `DialogFrame`, Wave's through its `Modal`, which
  draws the same frame (`DialogFrameClass`, `modal.scss`) and the same light. Popovers, menus, toasts and command
  surfaces (palette, command panel) keep their own look with 4 px corners and no light. `dialog-suite-frame.test.tsx`
  fails on a dialog without the frame and on an overlay with the 6 or 10 px radius.

## Molten motion

When MoltenTerm changes something before the developer's eyes (an agent adds a step, a card arrives, a list
reorders), the change flows like molten metal instead of cutting. One vocabulary serves the whole app:
`molten-motion.ts` (class names, timer values, hooks) and `molten-motion.css` (the look). It was introduced by the
pipeline setup's agent board (#1163); later screens adopt the same module, never a local copy.

- **Tokens** (`tokens.css`): `--mt-duration-flow` (320 ms, every change stays under 400 ms), `--mt-duration-fade`
  (120 ms, the reduced-motion form) and the one curve `--mt-ease`. The glow is the accent `--mt-accent`, the colour
  of the molten button's wave.
- **Classes**: `mt-flow-in` (an element grows into place and pushes its neighbours; an SVG node rises from
  `--mt-from-x` / `--mt-from-y` and swells into shape), `mt-arrive` (a whole screen replacing another, such as a
  stepper's next step: keyed by the screen, it rises into place without clipping anything), `mt-melt-out` (the reverse: it cools, blurs and drips away
  while the space closes), `mt-move` (positions and SVG path shapes travel rather than jump), `mt-glow-pass` (one
  pass of the molten glow over what changed) and `mt-glow` (a steady glow on what is pointed at, such as the step
  an agent explains; never a blink).
- **Hooks**: `useFlowList(items, keyOf)` returns entries with a phase (`enter`, `stay`, `exit`), keeping a leaving
  item one flow so it melts out where it was, and `flowClass(phase)` gives its class. A list row is wrapped in an
  element with that class, and the row's own box sits inside it. `useGlowPass(signature)` returns `mt-glow-pass`
  for one flow after the signature changes. `useFlipMove(ref, deps)` makes the `[data-motion-key]` elements under
  `ref` travel from their old place to the new one. Never put that attribute on an SVG element whose own `transform`
  attribute positions it, because the style would replace the attribute.
- **Reduced motion**: the system's preference and MoltenTerm's setting (the app root's `.prefers-reduced-motion`)
  turn every flow into a short fade (`--mt-duration-fade`, opacity only), stop transitions and leave a steady glow
  standing still. `prefersReducedMotion()` and `motionMs()` read the same two signals for timers.
- **Rules**: motion follows a change, never decorates a screen at rest. The first render of a list shows it as it
  is. Keep the terminal side free of layout work, and animate only `transform`, `opacity`, `filter`, `box-shadow`,
  the row's own `grid-template-rows` and an SVG path's `d`.
- **Panel motion** (FR-SHELL-112, `panel-motion/`): three moments, and only one moves at a time.
  - **The view pour**: at a switch, the view's panels slide 8 px from the tiles' side and fade in, and the clicked tile lights up in the action orange. It takes `--mt-duration-base` with `--mt-ease` (`useViewPour`, `PourLight`).
  - **A panel's arrival**: when a panel is added beside others, an orange edge runs once around its frame, then goes out. If the view's pour is still running, the edge waits for it (`PanelArrivalEdge`).
  - **A working agent**: the turning light of `GlowRing` goes round its view's tile in incandescent (`#FFB547`) instead of the dot. It turns in `--mt-duration-turn` (8 s), in 32 steps so that it costs 4 frames a second. It cools in `--mt-duration-cool` with `--mt-ease-cool` once the agent is done (`WorkingLight`).
  - **Under reduced motion**: the pour is instant; the arrival edge stands still as a full ring, then fades; the light stands still on the tile's top-right corner.
  - Only working indicators move continuously.

## Extraction plan

1. **Moves to the kit as is:** `suite.css`, `suite.tsx`, `suite-icons.ts` and this document. They import only React,
   `lucide-react` and each other; `suite.test.tsx` fails on any other import, on a Tailwind class inside the kit, and
   on an app variable (`--mt-*`). The package would be published as `@diamondforge/ui` (name to settle) with
   `lucide-react` as a peer dependency pinned to the suite's version (0.563.0 today).
2. **Each app keeps:** its accent and neutrals (the `--df-*` mapping on its `:root`), its type scale and durations
   (optional `--df-text-*` and `--df-duration-*` overrides), its buttons, its translations (the kit takes every word
   as a prop, such as `selectedLabel`), and its own Tailwind setup. The kit's rules sit in `@layer components` and
   re-declare Tailwind's layer order, so an app's utilities can still adjust a block.
3. **Overriding the accent:** set `--df-accent` and `--df-accent-fg` on `:root`. Notulia: `--df-accent:
var(--primary)` and `--df-accent-fg: var(--primary-foreground)` (violet). MoltenTerm: `var(--mt-accent)` and
   `var(--mt-accent-fg)` (the workspace colour). The tints (chip border, wash, shadow, glow) are computed in the
   rules with `color-mix`, so setting `--df-accent` on a subtree recolours just that subtree (that is how
   `tone="danger"` works).
4. **Notulia adopts it:** `SettingsFieldset` → `SectionBlock`, `OptionRow` → `OptionRow`, `.glow-ring` → `.df-glow`.
   The kit's turning light still rotates a conic gradient with a transform, which runs on the compositor, but the
   square is twice the frame's width instead of 99 999 px, so the GPU layer stays small. An animated registered
   `<angle>` property was tried and measured at about 10 % of the main thread while lit. Notulia's domain-tinted
   badges become a `--df-accent` override per block.
5. **Later migration, Font Awesome → Lucide in MoltenTerm.** Not in #658. These names stay Font Awesome for
   compatibility until a migration maps them:
   - Wave's own code (every `fa-*` class in `frontend/app/**`), left alone to ease upstream merges.
   - Icon names stored in user data: the workspace `icon` (`WorkspaceService.GetIcons`), block meta `icon`
     (`frontend/app/block/*`), `widgets.json` and `connections.json` icon names, and tab identity icons. Migrating
     them needs a name map (Font Awesome → Lucide) and a fallback for unknown names.
   - MoltenTerm's own shell surfaces (rail, tab bar, header, menus, command panel, notifications, Mission Control,
     review). They migrate together with their restyle, each through `suiteIcon`.
