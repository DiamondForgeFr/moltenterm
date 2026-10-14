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

- **The accent is the workspace colour**, molten orange by default (`--mt-accent`). `--df-accent` maps to it, so a
  block's chip and tile follow the workspace the way the rail and the molten buttons do.
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
  `GlowRing`.
- Icons: `suiteIcon("language")` and the other concepts in `suite-icons.ts`. Use named imports from `lucide-react`
  only.
- The mapping of the `--df-*` slots lives in `../tokens.css`. The token lint (`build/token-lint.ts`) accepts
  `var(--df-text-*)`, `var(--df-weight-*)` and `var(--df-duration-*)`. The build's radius cap (`build/cap-radius.ts`)
  leaves `--df-radius-*` alone.
- Applied in #658 to Settings (every group, Secrets, Mods, Advanced files and Keyboard) and the workspace editor
  (Identity, Project, Folder, Danger zone, and the dialog frame through `DialogFrame suite`). Tips follows through
  `PageCard`.

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
