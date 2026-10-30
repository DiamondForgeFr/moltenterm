// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { colord } from "colord";

// A panel painted by its own dark background, such as a terminal in a dark terminal theme, stays dark in the light
// theme (decision 7, FR-SHELL-121, #1341). Its frame carries data-mt-dark-surface, where tokens.css and
// moltenterm-shell.css give the dark theme's values back, so its header and marks read on it. A light terminal theme
// gives a light background and no island. The colour is judged without its alpha: the island lays the terminal
// surface under a see-through terminal (term:transparency).
export function isDarkSurface(bg: string): boolean {
    if (!bg) {
        return false;
    }
    const colour = colord(bg);
    if (!colour.isValid()) {
        return false;
    }
    return colour.alpha(1).isDark();
}
