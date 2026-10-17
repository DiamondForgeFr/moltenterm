// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every dialog follows the suite frame (#905): 4 px corners, the thin border and the turning light, through DialogFrame
// or Wave's Modal; overlays that are not dialogs (popovers, menus, toasts, command surfaces) keep low corners.

import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    const createPortal = (node: React.ReactNode) => node;
    // Wave's Modal calls the default export.
    return { ...actual, default: { ...actual, createPortal }, createPortal };
});

import { FlexiModal, Modal } from "@/app/modals/modal";
import { DialogFrame, DialogFrameClass } from "./dialog-frame";

const FrontendDir = fileURLToPath(new URL("..", import.meta.url));

// A dialog element carrying the frame's marker and a lit ring, in that order of nesting.
const FramedAndLit =
    /class="[^"]*\bmolten-dialog-frame\b[^"]*"[^>]*>(?:(?!<\/div>)[\s\S])*?<span class="df-glow" data-on=""/;

// Files that may draw a scrim or a modal dialog themselves: the two frames, and the command panel, a command surface
// without a scrim (modal-open.ts) whose aria-modal only keeps the keyboard in it.
const OwnModalAllowed: Record<string, string> = {
    "moltenterm-shell/dialog-frame.tsx": "the suite's dialog frame",
    "app/modals/modal.tsx": "Wave's Modal, drawn with the suite frame",
    "moltenterm-shell/command-panel/command-panel.tsx": "a command surface (low corners, no light)",
    // Reads the open dialogs, draws none.
    "moltenterm-shell/tab-close-confirmation.tsx": "uses DialogFrame",
};

// Overlay frames: fixed, or floating with an overlay shadow. Only the token radii count: the build caps every other
// radius (Wave's rounded-lg included) at 3 px (build/cap-radius.ts).
const OverlayMarker = /\b(fixed|shadow-command|shadow-e2|shadow-e3|shadow-lg|shadow-xl)\b/;
const HighCorner = /\brounded-(6|10)\b/;

function sourceFiles(dir: string, ext: RegExp): string[] {
    return (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => ext.test(f) && !/\.test\.|node_modules|[\\/]preview[\\/]/.test(f))
        .map((f) => join(dir, f));
}

function rel(file: string): string {
    return relative(FrontendDir, file).split("\\").join("/");
}

beforeAll(() => {
    vi.stubGlobal("document", { body: {}, getElementById: () => ({}) });
});

describe("the suite frame on every dialog (#905)", () => {
    it("DialogFrame draws the frame, low-cornered, with its light", () => {
        expect(DialogFrameClass).toMatch(/\brounded-4\b/);
        expect(DialogFrameClass).toMatch(/\bborder\b/);
        const html = renderToStaticMarkup(
            <DialogFrame role="t" title="T" buttons={null}>
                <p />
            </DialogFrame>
        );
        expect(html).toMatch(/role="dialog"[^>]*class="[^"]*\bmolten-dialog-frame\b/);
        expect(html).toContain('<span class="df-glow" data-on=""');
    });

    it("Wave's Modal and FlexiModal carry the frame and a lit ring", () => {
        expect(renderToStaticMarkup(<Modal onClose={() => {}}>Body</Modal>)).toMatch(FramedAndLit);
        expect(renderToStaticMarkup(<FlexiModal>Body</FlexiModal>)).toMatch(FramedAndLit);
    });

    it("lets a stacked Wave Modal opt out of the light, keeping the frame", () => {
        const html = renderToStaticMarkup(
            <Modal noGlow onClose={() => {}}>
                Body
            </Modal>
        );
        expect(html).toContain("molten-dialog-frame");
        expect(html).not.toContain("df-glow");
    });

    it("builds no scrim or modal dialog outside the two frames", () => {
        const offenders = sourceFiles(FrontendDir, /\.tsx$/)
            .filter((f) => !(rel(f) in OwnModalAllowed))
            .filter((f) => {
                const src = readFileSync(f, "utf8");
                return /aria-modal="true"|aria-modal=\{true\}|\bScrimClass\b|"modal-backdrop"|showModal\(\)/.test(src);
            })
            .map(rel);
        expect(offenders).toEqual([]);
    });

    it("gives every overlay frame low corners", () => {
        const offenders: string[] = [];
        for (const f of sourceFiles(FrontendDir, /\.tsx$/)) {
            const src = readFileSync(f, "utf8");
            for (const m of src.matchAll(/"([^"\n]*)"/g)) {
                if (OverlayMarker.test(m[1]) && HighCorner.test(m[1])) {
                    offenders.push(`${rel(f)}: ${m[1]}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("draws no MoltenTerm overlay with the 10 px radius in CSS", () => {
        const offenders = sourceFiles(join(FrontendDir, "moltenterm-shell"), /\.css$/)
            .filter((f) => /border-radius:\s*var\(--(mt-)?radius-10\)/.test(readFileSync(f, "utf8")))
            .map(rel);
        expect(offenders).toEqual([]);
    });
});
