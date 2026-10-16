// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot } from "react-dom/client";
import { EndSessionDialog } from "../../frontend/moltenterm-shell/sessions/sessions-dialogs";
import { WorktreeCloseDialog } from "../../frontend/moltenterm-shell/worktree-close";
import { ModsSection } from "../../frontend/moltenterm-shell/settings/settings-mods";
import { PresetColours, PresetGradients } from "../../frontend/moltenterm-shell/workspace-colour";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mount = document.createElement("main");
document.body.append(mount);
const root = createRoot(mount);
const session = { id: "fixture", shortid: "fixture", connection: "", connstate: "connected" as const,
    workspaceorder: 0, shown: false, canshow: false, canend: true, command: "fixture command" };
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
function measure(el: HTMLElement) {
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
const noop = () => {};
async function render(kind: string) {
    await act(async () => root.render(kind === "worktree"
        ? <WorktreeCloseDialog request={{ path: "/fixture/worktree", blockId: "fixture", close: noop }} onDone={noop} />
        : kind === "session"
          ? <EndSessionDialog session={session} home="/fixture" now={1} onKeep={noop}
                onEnd={async () => { throw new Error("Unable to end the session: fixture failure"); }} />
          : <div className="bg-surface-3 p-4"><ModsSection /></div>));
    if (kind === "session") {
        const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(el => el.textContent.includes("End session"));
        if (!confirm) throw new Error("Missing real session confirmation button");
        await act(async () => confirm.click());
    }
    if (!document.body.textContent.includes("fixture failure")) throw new Error(`Missing real ${kind} error`);
}
const choices = [...new Set([
    ...PresetColours.map(c => c.value), ...PresetGradients.flatMap(c => c.value.split(",")),
    // Custom/old workspace choices include the extrema; surfaces mix the accent linearly in sRGB.
    "#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#00ffff", "#ff00ff",
])];
(globalThis as any).renderContrastCase = render;
(globalThis as any).runContrastChecks = async (recipes: string[]) => {
    const rows: unknown[] = [];
    for (const kind of ["worktree", "session", "mods"]) {
        await render(kind);
        const errors = Array.from(document.querySelectorAll<HTMLElement>("div, span, p"))
            .filter(el => el.children.length === 0 && (el.textContent.includes("fixture failure") || el.matches('[data-mod] .text-danger')));
        if (!errors.length) throw new Error(`Missing ${kind} measured text`);
        for (const accent of choices) {
            document.documentElement.style.setProperty("--mt-accent", accent);
            for (const el of errors) {
                const result = measure(el);
                if (result.ratio < 4.5) throw new Error(`${kind} ${accent}: ${JSON.stringify(result)} ${el.outerHTML}`);
                rows.push({ kind, accent, text: el.textContent, ...result });
            }
        }
    }
    await act(async () => root.render(null));
    // Render the actual migrated utility recipes, including tinted panels and the hover fill of destructive text.
    const probe = document.createElement("div");
    mount.append(probe);
    for (const surface of ["bg-surface-1", "bg-surface-2", "bg-surface-3"]) {
        probe.className = surface;
        for (const recipe of recipes) {
            const text = document.createElement("span");
            text.className = recipe;
            text.textContent = "Failure";
            probe.replaceChildren(text);
            for (const accent of choices) {
                document.documentElement.style.setProperty("--mt-accent", accent);
                const result = measure(text);
                if (result.ratio < 4.5) throw new Error(`${surface} ${recipe} ${accent}: ${JSON.stringify(result)}`);
                rows.push({ kind: "migrated recipe", surface, recipe, accent, ...result });
            }
        }
    }
    probe.remove();
    return { samples: rows.length, accents: choices.length, minimum: Math.min(...rows.map((r: any) => r.ratio)), rows };
};
