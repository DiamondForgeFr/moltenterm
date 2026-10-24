// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// React bubbles a portal's events through the React tree, not the DOM: a click in a dialog drawn over the window
// (DialogFrame portals into document.body) reaches the onClick of the block whose view opened it. Wave's block then
// sees the focus outside its element and focuses its hidden input, which closes the dialog's open select or date
// picker in the same click (#1070). An event whose target is outside the block's element is not the block's.
export function cameThroughPortal(
    event: { target: EventTarget },
    blockElem: { contains: (other: Node) => boolean }
): boolean {
    const target = event?.target;
    return blockElem != null && target != null && !blockElem.contains(target as Node);
}
