// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import "slices"

// Opener tabs (#892): a tab MoltenTerm shows on the developer's behalf from another tab (a PR's Review tab opened from
// the PR list, an agent's tab...) keeps that tab's id in its meta; closing it goes back there, the way a browser returns
// to the opener tab, instead of to the tab next to it.

// must match frontend/moltenterm-shell/opener-tab.ts
const OpenerTabMetaKey = "molten:openertab"

// ShownOpener returns the opener when it is still one of the workspace's tabs (tabIds, without the closed tab) and not
// a hidden one; "" otherwise.
func ShownOpener(tabIds []string, hidden []string, opener string) string {
	if opener == "" || !slices.Contains(tabIds, opener) || slices.Contains(hidden, opener) {
		return ""
	}
	return opener
}
