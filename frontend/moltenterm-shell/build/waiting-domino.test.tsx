// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Waiting = domino (DS-SHELL-154, FR-SHELL-076 AC4, #1714): where the user waits for an action or an agent works, the
// one domino loader shows, never a spinner icon and never a busy label alone. The guard reads the sources: a spinner
// usage fails, and so does a file that shows a busy label (an i18n value ending in "…" that names work under way) but
// draws no loader. An exception goes in the allow-lists below with its reason.

import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import { DominoLoader } from "../suite/suite";

const Root = resolve(__dirname, "../../..");
const SourceDirs = ["frontend", "emain"];

// Font Awesome's spin, Tailwind's spin, a spinning icon button and the "+spin" icon modifier.
export const SpinnerPattern = /fa-spinner|fa-circle-notch|\bfa-spin\b|\banimate-spin\b|\biconSpin:\s*true|"[a-z0-9-]+\+spin"/;

// What draws the loader: the component, the loading state, and the shell's wrappers built on them.
export const LoaderPattern = /\b(DominoLoader|LoadingState|RunningDot|LazyViewLoading)\b/;

// A label of work under way: a gerund ("Removing…", "Reading the worktree…") or a key that names it.
const Gerund = /\b[a-zA-Z]+ing\b/;
const BusyKeyName =
    /(loading|running|reading|starting|pending|sending|syncing|checking|looking|preparing|computing|asking|cleaning|removing|deploying|cancelling|closing|trusting|waiting|dispatching|refreshing|initializing|saving)/i;

// file → why its spinner-looking code is not a spinner on screen.
export const SpinnerAllowed: Record<string, string> = {
    "frontend/util/util.ts": "makeIconClass maps the +spin modifier to Font Awesome's class: the mechanism, not a usage",
    "frontend/app/block/connectionbutton.tsx": "Wave's shouldSpin is never set true; connecting draws its dots",
    "frontend/moltenterm-onboarding/onboarding-pour-scenes.tsx": "agent install cards of the first launch: #1712",
};

// file → why it shows a busy label without drawing the loader itself.
export const BusyLabelAllowed: Record<string, string> = {
    // Models and texts: the label is drawn by a component that shows the loader next to it.
    "frontend/moltenterm-shell/companion/companion-model.ts":
        "statusMessage: companion-view's EmptyState draws the card dominoes while the session loads",
    "frontend/moltenterm-shell/mission/dep-sync-model.ts": "the syncing note: group-strip shows RunningDot while it syncs",
    "frontend/moltenterm-shell/mission/release-run.ts":
        "phase actions and lines: release-run-panel draws PendingLabel and the running step's dominoes",
    "frontend/moltenterm-shell/review/review-merge.ts":
        "the disabled Merge's tooltip; the step line under it is the stepper's running step, with its dominoes",
    "frontend/moltenterm-shell/review/review-publish.ts": "review-publish-sheet draws the dominoes while it works",
    "frontend/moltenterm-shell/review/review-restart.ts": "review-restart-view swaps the icon for the dominoes",
    "frontend/moltenterm-shell/review/review-stepper.ts": "review-stepper-view draws the running step's dominoes",
    "frontend/moltenterm-shell/reviews/reviews-forecast-model.ts": "reviews-forecast draws the dominoes while it computes",
    "frontend/moltenterm-shell/reviews/reviews-launch-model.ts": "reviews-launch draws the dominoes while it starts",
    "frontend/moltenterm-shell/reviews/reviews-model.ts": "mergeLabel and reportLabel are not drawn (tests only)",
    "frontend/moltenterm-shell/sessions/sessions-bulk.ts": "sessions-dialogs' buttons and result marks draw the dominoes",
    "frontend/moltenterm-shell/sessions/sessions-model.ts": "the connection chip's tooltip; its dot says the state",
    "frontend/moltenterm-shell/view-pending.tsx": "the caption under PendingSurface's large dominoes (DominoLoader)",
    "emain/moltenterm-view-pending.ts": "static page before the renderer: it draws its own copy of the large dominoes",
    // Components whose shared part draws the loader.
    "frontend/moltenterm-shell/browser/browser-error-page.tsx": "EmptyState's busy action draws the dominoes",
    "frontend/moltenterm-shell/lazy/monaco-lazy.tsx": "LazyViewLoading is the loading state",
    "frontend/app/view/preview/preview-model.tsx": "the header Pill with busy draws the dominoes",
    // #1712 owns the agent install cards (first launch and Library › Agents).
    "frontend/moltenterm-onboarding/onboarding-pour-scenes.tsx": "agent install cards of the first launch: #1712",
    "frontend/moltenterm-shell/library/agents-section.tsx": "agent install cards of Library › Agents: #1712",
};

// A busy text written in the code rather than through a key (Wave's surfaces): "Loading...", "Saving…".
export const LiteralBusyPattern = /(>|["'`])\s*(Loading|Saving|Deleting|Adding|Connecting|Starting)\b[^"'`<]*(\.\.\.|…)/;

// file → why its literal busy text needs no loader.
export const LiteralBusyAllowed: Record<string, string> = {
    "frontend/app/treeview/treeview.tsx": "a tree row's label, only used by the component preview server",
    "frontend/app/element/markdown.tsx": "Mermaid's placeholder text, written into the diagram's node while it renders",
};

function sourceFiles(): string[] {
    const files: string[] = [];
    for (const dir of SourceDirs) {
        for (const rel of readdirSync(join(Root, dir), { recursive: true }) as string[]) {
            const path = `${dir}/${rel.split("\\").join("/")}`;
            if (!/\.(ts|tsx)$/.test(path) || /\.test\.tsx?$/.test(path) || path.includes("node_modules")) {
                continue;
            }
            if (path.startsWith("frontend/types/")) {
                continue;
            }
            files.push(path);
        }
    }
    return files;
}

export function busyKeys(dict: object, prefix = ""): string[] {
    const keys: string[] = [];
    for (const [k, v] of Object.entries(dict)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v != null && typeof v === "object") {
            keys.push(...busyKeys(v, key));
            continue;
        }
        if (typeof v !== "string" || !/(…|\.\.\.)\s*$/.test(v)) {
            continue;
        }
        if (Gerund.test(v) || BusyKeyName.test(k)) {
            keys.push(key);
        }
    }
    return keys;
}

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("waiting = domino (DS-SHELL-154, #1714)", () => {
    const files = sourceFiles().map((path) => ({ path, src: readFileSync(join(Root, path), "utf8") }));
    const keys = busyKeys(en);

    it("finds the busy labels", () => {
        expect(keys).toContain("worktree.close.removing");
        expect(keys).toContain("mc.frame.initializing");
        expect(keys).not.toContain("rail.menu.editWorkspace");
        expect(keys).not.toContain("palette.placeholder");
    });

    it("catches spinner usages", () => {
        expect(SpinnerPattern.test('<i className="fa fa-spinner fa-spin" />')).toBe(true);
        expect(SpinnerPattern.test('<i className="animate-spin" />')).toBe(true);
        expect(SpinnerPattern.test("iconSpin: true,")).toBe(true);
        expect(SpinnerPattern.test('icon: "rotate+spin"')).toBe(true);
        expect(SpinnerPattern.test('<i className="fa fa-solid fa-rotate" />')).toBe(false);
    });

    it("shows no spinner", () => {
        const found = files
            .filter((f) => SpinnerAllowed[f.path] == null && SpinnerPattern.test(stripComments(f.src)))
            .map((f) => f.path);
        expect(found).toEqual([]);
    });

    it("draws the loader wherever a busy label shows", () => {
        const found: string[] = [];
        for (const f of files) {
            if (BusyLabelAllowed[f.path] != null || LoaderPattern.test(f.src)) {
                continue;
            }
            const used = keys.filter((k) => f.src.includes(`"${k}"`));
            if (used.length > 0) {
                found.push(`${f.path}: ${used.join(", ")}`);
            }
        }
        expect(found).toEqual([]);
    });

    it("draws the loader next to a literal busy text (Wave's untranslated Loading...)", () => {
        const found = files
            .filter(
                (f) =>
                    LiteralBusyAllowed[f.path] == null &&
                    LiteralBusyPattern.test(stripComments(f.src)) &&
                    !LoaderPattern.test(f.src)
            )
            .map((f) => f.path);
        expect(found).toEqual([]);
    });

    it("keeps no stale exception", () => {
        const stale = [
            ...Object.keys(SpinnerAllowed).filter((path) => {
                const f = files.find((x) => x.path === path);
                return f == null || !SpinnerPattern.test(stripComments(f.src));
            }),
            ...Object.keys(BusyLabelAllowed).filter((path) => {
                const f = files.find((x) => x.path === path);
                return f == null || !keys.some((k) => f.src.includes(`"${k}"`));
            }),
        ];
        expect(stale).toEqual([]);
    });

    it("sizes the loader for its place", () => {
        expect(renderToStaticMarkup(<DominoLoader />)).toContain('class="df-domino-loader"');
        expect(renderToStaticMarkup(<DominoLoader size="card" />)).toContain('class="df-dominos df-dominos-card"');
        expect(renderToStaticMarkup(<DominoLoader size="large" />)).toContain('class="df-dominos"');
        const css = readFileSync(join(Root, "frontend/moltenterm-shell/suite/suite.css"), "utf8");
        expect(css).toMatch(/\.df-dominos\.df-dominos-card\s*\{\s*zoom:\s*0\.5;/);
    });
});
