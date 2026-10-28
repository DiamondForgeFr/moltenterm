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
export function measure(el: HTMLElement) {
    const chain: HTMLElement[] = [];
    for (let parent = el; parent; parent = parent.parentElement) chain.unshift(parent);
    let background = [255, 255, 255];
    for (const parent of chain) {
        const style = getComputedStyle(parent);
        if (style.backgroundImage !== "none" || Number(style.opacity) !== 1) {
            throw new Error(`Unsupported compositing in contrast fixture: ${parent.outerHTML.slice(0, 160)}`);
        }
        background = over(rgba(style.backgroundColor), background);
    }
    const foreground = over(rgba(getComputedStyle(el).color), background);
    const a = luminance(foreground), b = luminance(background);
    return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), foreground, background };
}
export const choices = [...new Set([
    ...PresetColours.map(c => c.value), ...PresetGradients.flatMap(c => c.value.split(",")),
    // Custom/old workspace choices include the extrema; surfaces mix the accent linearly in sRGB.
    "#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#00ffff", "#ff00ff",
])];
