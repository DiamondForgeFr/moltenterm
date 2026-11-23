# UI checklist

A short checklist for a ticket labelled `ui`, the same for every coding agent. Go through it when you draw the mockup and again before the pull request. Each line is a check, not a style guide: the
project's own design system and design tokens win over anything written here.

## Hierarchy

- One primary action per screen or view, visually the strongest; secondary actions are quieter.
- The reading order follows importance: the title, then the content the user came for, then the controls. Related things are grouped and unrelated things are apart.
- Size, weight and position carry the structure, not colour alone.

## Spacing and design tokens

- Colours, type sizes, radii, shadows and spacing come from the project's design tokens (the project's `AGENTS.md` says where they live). No raw colour value and no one-off pixel value where a token
  exists.
- Spacing follows one scale: related items are closer than unrelated ones, and edges line up on a shared grid.
- When no token covers what you need, say so in your report and do not invent a parallel set. In the mockup, declare the tokens as CSS custom properties on `:root`, so that the implementation maps
  them one to one.

## States

Draw every state a user can meet, not only the happy path:

- **Empty**: what is missing and what to do about it.
- **Loading**: a skeleton or an indicator, with no jump of the layout when the content arrives.
- **Error**: what went wrong and how to recover, next to where it happened.
- **Disabled**: it looks inactive, and says why when that is not obvious.
- Also hover, focus and pressed, success, one item and many items, and a text that is far longer than the sample.

## Accessibility

- **Contrast**: text at least 4.5:1 (large text 3:1); controls and focus indicators at least 3:1 against their background.
- **Keyboard**: everything is reachable and operable with the keyboard alone, in a logical order, with no trap.
- **Focus**: a visible focus indicator on every interactive element, and focus lands where the user expects when a dialog or a view opens and closes.
- **Labels**: every field has a visible label (a placeholder is not one), an icon-only control has an accessible name, an image has a text alternative or is marked decorative, and no state is conveyed
  by colour alone.
- **Targets**: at least 24 by 24 CSS pixels, larger for touch. Motion respects the reduced-motion preference.

## Copy

- Say what the control does: a verb on a button ("Save changes", not "OK"), and the same word for the same thing everywhere.
- An error says what happened and what to do, in plain words, without blame and without a bare code.
- An empty state or a confirmation names the object and the consequence.
- Short, in sentence case, with no truncation that hides the meaning. Strings go through the project's translation mechanism when it has one.

## The mockup file

- One HTML file with its CSS inline, no build step and no request to the network (a system font stack, images inline): it opens in any browser from its path.
- It reads at phone width and at desktop width, and shows the states above, side by side or behind a small switch.
- Its title names the ticket.
