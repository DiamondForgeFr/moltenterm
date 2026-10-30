// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The colours a workspace can take (#657): its project logo's colours and gradients first, then presets spread around
// the hue wheel, curated gradients and a custom colour. A choice is a string of 1-3 lowercase #rrggbb stops joined by
// commas, the way accent.ts reads and stores it.

import { gradientForeground, normaliseColourChoice, parseColor } from "./accent";
import { t } from "./i18n/i18n";

// Around the hue wheel, all light enough to read on the dark theme. wavesrv's colours (pkg/wcore/workspace.go,
// WorkspaceColors) are among them, so a workspace that has one keeps it selected.
export const PresetColours: { value: string; name: string }[] = [
    { value: "#ff453a", name: "red" },
    { value: "#ff6f61", name: "coral" },
    { value: "#ff7c0d", name: "orange" },
    { value: "#ffa94d", name: "apricot" },
    { value: "#ffc53d", name: "amber" },
    { value: "#ffe900", name: "yellow" },
    { value: "#c5e84a", name: "lime" },
    { value: "#58c142", name: "green" },
    { value: "#2ecc71", name: "emerald" },
    { value: "#3ddc97", name: "mint" },
    { value: "#00ffdb", name: "teal" },
    { value: "#22d3ee", name: "cyan" },
    { value: "#38bdf8", name: "sky" },
    { value: "#429dff", name: "blue" },
    { value: "#6b8cff", name: "cornflower" },
    { value: "#8b7bff", name: "indigo" },
    { value: "#a66bff", name: "violet" },
    { value: "#bf55ec", name: "purple" },
    { value: "#e15bf0", name: "orchid" },
    { value: "#ff5fb8", name: "pink" },
    { value: "#ff8fab", name: "rose" },
    { value: "#d9a66b", name: "sand" },
    { value: "#9fb1c8", name: "slate" },
    { value: "#d6dde6", name: "mist" },
];

export const PresetGradients: { value: string; name: string }[] = [
    { value: "#ffc53d,#ff7c0d,#ff453a", name: "ember" },
    { value: "#ff7c0d,#ff5fb8,#a66bff", name: "sunset" },
    { value: "#00ffdb,#429dff", name: "ocean" },
    { value: "#c5e84a,#2ecc71,#22d3ee", name: "aurora" },
    { value: "#ff5fb8,#8b7bff", name: "berry" },
];

// The custom colour's swatch before one is picked: a hue wheel of presets. The picker opens on the default colour.
export const CustomColourWheel = "conic-gradient(#ff453a, #ffe900, #58c142, #00ffdb, #429dff, #bf55ec, #ff453a)";
export const CustomColourStart = "#ff7c0d";

const ColourNames = new Map(PresetColours.map((c) => [c.value, c.name]));
const GradientNames = new Map(PresetGradients.map((g) => [g.value, g.name]));

export function colourStops(choice: string): string[] {
    const normal = normaliseColourChoice(choice);
    return normal ? normal.split(",") : [];
}

// How a swatch is announced (NFR-SHELL-014): its name, never its colour alone; an unnamed colour by its hex value.
export function colourChoiceName(choice: string): string {
    const normal = normaliseColourChoice(choice);
    if (!normal) {
        return choice ? choice : t("workspace.colours.none");
    }
    const stops = normal.split(",");
    if (stops.length === 1) {
        const name = ColourNames.get(normal);
        return name ? t(`workspace.colours.${name}`) : normal;
    }
    const gradient = GradientNames.get(normal);
    if (gradient) {
        return t(`workspace.gradients.${gradient}`);
    }
    return t("workspace.colours.gradient", {
        from: colourChoiceName(stops[0]),
        to: colourChoiceName(stops[stops.length - 1]),
    });
}

// The swatch's paint: the colour, or the gradient at the angle given.
export function colourChoiceCss(choice: string, angle = "135deg"): string {
    const stops = colourStops(choice);
    if (stops.length === 0) {
        return "transparent";
    }
    return stops.length === 1 ? stops[0] : `linear-gradient(${angle}, ${stops.join(", ")})`;
}

// The check mark drawn on a swatch, readable over all of it.
export function colourChoiceForeground(choice: string): string {
    return gradientForeground(colourStops(choice).map(parseColor));
}

// The logo's colours, each on its own, then one gradient of the first two and, with three or more, one of the first
// three: the dominant colour leads.
export function logoColourChoices(colours: string[]): string[] {
    const stops = (colours ?? []).map((c) => normaliseColourChoice(c)).filter((c) => c && !c.includes(","));
    const unique = stops.filter((c, i) => stops.indexOf(c) === i);
    const out = [...unique];
    if (unique.length >= 2) {
        out.push(unique.slice(0, 2).join(","));
    }
    if (unique.length >= 3) {
        out.push(unique.slice(0, 3).join(","));
    }
    return out;
}

export const PresetColourChoices = PresetColours.map((c) => c.value);
export const PresetGradientChoices = PresetGradients.map((g) => g.value);

// The short version of the palette (FR-SHELL-102): ten of the presets spread around the hue wheel, shown first on the
// New workspace page; "More colours" there opens the full palette above.
const ShortPaletteNames = ["red", "orange", "amber", "lime", "green", "teal", "sky", "blue", "violet", "pink"];

export const ShortPaletteColours: string[] = ShortPaletteNames.map(
    (name) => PresetColours.find((c) => c.name === name)?.value
).filter((v) => !!v);

// Red reads as danger or deletion (audit #1316 F14): a workspace is never given it unasked. Its hue band, around 0°,
// takes in red and coral; pink and rose sit far enough from it.
export function isRedColour(choice: string): boolean {
    const stops = colourStops(choice);
    if (stops.length !== 1) {
        return false;
    }
    const { r, g, b } = parseColor(stops[0]);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 0.25 * max || max !== r) {
        return false;
    }
    const hue = (60 * (g - b)) / (max - min);
    return hue > -15 && hue < 15;
}

// A custom colour typed in: "#rrggbb", "rrggbb" or "#rgb", or "" while it is not one yet.
export function parseCustomColour(text: string): string {
    const value = (text ?? "").trim();
    if (value === "") {
        return "";
    }
    const withHash = value.startsWith("#") ? value : "#" + value;
    const normal = normaliseColourChoice(withHash);
    return normal && !normal.includes(",") ? normal : "";
}
