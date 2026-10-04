// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Molten call-to-action buttons (FR-SHELL-014). molten-button.css holds the look; this module maps Wave's Button
// classes onto it and provides the wave layer that a molten button carries as its last child.

const CategoryTokens = new Set(["solid", "outlined", "outline", "ghost"]);
const ColourTokens = new Set(["green", "grey", "red", "yellow"]);

export type MoltenButtonVariant = "primary" | "destructive" | "warning" | "secondary" | "outline" | "ghost";

export type MoltenButtonStyle = {
    variant: MoltenButtonVariant;
    // The classes to render, after the caller's own: Wave's colour token is replaced where Moltenterm restyles it.
    className: string;
    // Molten variants carry the wave layer.
    wave: boolean;
};

const SolidColours: Record<string, { variant: MoltenButtonVariant; classes: string[]; keep: boolean }> = {
    green: { variant: "primary", classes: ["molten-btn"], keep: false },
    red: { variant: "destructive", classes: ["molten-btn", "molten-btn-destructive"], keep: false },
    yellow: { variant: "warning", classes: ["molten-btn", "molten-btn-warning"], keep: false },
    grey: { variant: "secondary", classes: ["molten-btn-secondary"], keep: true },
};

// Wave's Button picks a category (solid, outlined, ghost) and a colour (green, grey, red, yellow) from its class
// names, solid and green by default. Whole tokens are matched: Wave sniffed substrings, so "fa-solid" on an icon
// button read as a category.
export function moltenButtonClasses(className: string): MoltenButtonStyle {
    const tokens = (className ?? "").split(/\s+/).filter((t) => t !== "");
    const category = tokens.find((t) => CategoryTokens.has(t)) ?? "solid";
    const colour = tokens.find((t) => ColourTokens.has(t)) ?? "green";
    const rest = tokens.filter((t) => !ColourTokens.has(t));
    const withCategory = tokens.some((t) => CategoryTokens.has(t)) ? rest : ["solid", ...rest];

    if (category === "solid") {
        const solid = SolidColours[colour];
        const kept = solid.keep ? [colour] : [];
        return {
            variant: solid.variant,
            className: [...solid.classes, ...kept, ...withCategory].join(" "),
            wave: solid.classes.includes("molten-btn"),
        };
    }
    // A green outline or ghost takes the workspace accent; the others keep Wave's grey, red and yellow tokens.
    const variant: MoltenButtonVariant = category === "ghost" ? "ghost" : "outline";
    const tone = colour === "green" ? ["molten-tone-accent"] : [colour];
    return {
        variant,
        className: [`molten-btn-${variant}`, ...tone, ...withCategory].join(" "),
        wave: false,
    };
}

// The wave of a molten button (molten-button.css). It sits behind the content inside the button's own stacking
// context, so the content needs no wrapper; outside a .molten-btn it is not displayed.
export function MoltenWave() {
    return <i className="molten-btn-wave" aria-hidden="true" />;
}
