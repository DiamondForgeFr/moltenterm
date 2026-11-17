// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { PresetColours, PresetGradients } from "../../frontend/moltenterm-shell/workspace-colour";

const canvas = document.createElement("canvas");
canvas.width = canvas.height = 1;
const context = canvas.getContext("2d", { willReadFrequently: true });
const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data).map((v, i) => i === 3 ? v / 255 : v);
};
const over = (front: number[], back: number[]) => front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3]));
const luminance = (color: number[]) => color.reduce((sum, channel, i) => {
    const s = channel / 255;
    return sum + (s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
}, 0);
// The colour stops of a gradient background, or null for any other image. A gradient is painted over the element's
// background colour, so the text is measured over each stop as well as over the colour alone, and must hold on the
// worst: the first launch's glow (#2304) is a radial gradient over its iron.
const ColourRe = /(?:color-mix|rgba?|hsla?|color|oklch|oklab|lab|lch)\((?:[^()]|\([^()]*\))*\)/g;
function gradientStops(image: string): string[] {
    const layers: string[] = [];
    let depth = 0, current = "";
    for (const ch of image) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
            layers.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    layers.push(current.trim());
    const gradients = layers.filter(layer => layer !== "none");
    if (gradients.some(layer => !/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/.test(layer))) return null;
    return gradients.flatMap(layer => layer.match(ColourRe) ?? []);
}
const ratioOf = (foreground: number[], background: number[]) => {
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
export function measure(el: HTMLElement) {
    const chain: HTMLElement[] = [];
    for (let parent = el; parent; parent = parent.parentElement) chain.unshift(parent);
    let backgrounds = [[255, 255, 255]];
    for (const parent of chain) {
        const style = getComputedStyle(parent);
        const stops = style.backgroundImage === "none" ? [] : gradientStops(style.backgroundImage);
        if (stops == null || Number(style.opacity) !== 1) {
            throw new Error(
                `Unsupported compositing in contrast fixture (background ${style.backgroundImage}, opacity ${style.opacity}): ${parent.outerHTML.slice(0, 160)}`
            );
        }
        backgrounds = backgrounds.flatMap(under => {
            const base = over(rgba(style.backgroundColor), under);
            return [base, ...stops.map(stop => over(rgba(stop), base))];
        });
    }
    const color = rgba(getComputedStyle(el).color);
    const rows = backgrounds.map(background => {
        const foreground = over(color, background);
        return { ratio: ratioOf(foreground, background), foreground, background };
    });
    return rows.reduce((worst, row) => (row.ratio < worst.ratio ? row : worst));
}
export const choices = [...new Set([
    ...PresetColours.map(c => c.value), ...PresetGradients.flatMap(c => c.value.split(",")),
    // Custom/old workspace choices include the extrema; surfaces mix the accent linearly in sRGB.
    "#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#00ffff", "#ff00ff",
])];
