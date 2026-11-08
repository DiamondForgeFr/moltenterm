// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Hoisted = vi.hoisted(() => ({ platform: "darwin" }));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws1", name: "Alpha" }) } };
});
vi.mock("../keepawake-ui", () => ({ usePlatform: () => Hoisted.platform, useNow: () => 0 }));
vi.mock("../keepawake-cup", () => ({ HoldRow: () => <li data-testid="mock-hold" /> }));
vi.mock("../settings/settings-open", () => ({ openSettingsKey: vi.fn() }));
vi.mock("../keepawake-store", async () => {
    const { atom } = await import("jotai");
    const stateAtom = atom({});
    const model = { stateAtom, setCoffee: vi.fn(), setAutomatic: vi.fn() };
    return { KeepAwakeModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { EmptyKeepAwakeState, keepAwakeActive, KeepAwakeState } from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { BrokkKeepAwakePanel } from "./brokk-keepawake-panel";

const model = KeepAwakeModel.getInstance() as any;

function setState(partial: Partial<KeepAwakeState>) {
    globalStore.set(model.stateAtom, { ...EmptyKeepAwakeState, version: 1, ...partial });
}

function render(): string {
    return renderToStaticMarkup(<BrokkKeepAwakePanel onLeave={() => {}} onClose={() => {}} />);
}

function text(html: string, testid: string): string {
    const start = html.indexOf(`data-testid="${testid}"`);
    expect(start).toBeGreaterThan(-1);
    return html.slice(html.indexOf(">", start) + 1, html.indexOf("</", html.indexOf(">", start)));
}

beforeEach(() => {
    Hoisted.platform = "darwin";
    setState({});
});

// #2089: the panel read as contradictory, the switch off while the computer was kept awake. It leads with the real
// state and its cause now, whatever the switches say.
describe("the Garder éveillé panel leads with the real state (FR-BOSS-009, AC44)", () => {
    it("states the computer is kept awake by Automatic while agents work, with Manual off", () => {
        setState({
            hold: true,
            automatic: true,
            automaticholding: true,
            automaticworking: true,
            automaticreasons: ["Léa: working", "Juliette: working"],
        });
        const html = render();
        expect(html).toContain('data-testid="brokk-keepawake" data-awake="true"');
        expect(text(html, "brokk-keepawake-state")).toBe("This computer stays awake");
        expect(text(html, "brokk-keepawake-cause")).toBe("Automatic (Léa: working, Juliette: working)");
        expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Manual"/);
        expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Automatic"/);
    });

    it("states the computer is not kept awake when both modes are off", () => {
        setState({ automatic: false, requests: "never" });
        const html = render();
        expect(html).toContain('data-awake="false"');
        expect(text(html, "brokk-keepawake-state")).toBe("Not keeping this computer awake");
        expect(text(html, "brokk-keepawake-cause")).toBe("Automatic and manual are off.");
        expect(html).not.toContain('data-testid="brokk-keepawake-reason"');
    });

    it("puts the state before the switches, the switches before the reasons", () => {
        setState({ hold: true, automatic: true, automaticholding: true, automaticworking: true });
        const html = render();
        const state = html.indexOf('data-testid="brokk-keepawake-state"');
        const modes = html.indexOf('data-testid="keepawake-modes"');
        const reasons = html.indexOf('data-testid="brokk-keepawake-reason"');
        expect(state).toBeGreaterThan(-1);
        expect(state).toBeLessThan(modes);
        expect(modes).toBeLessThan(reasons);
    });

    it("answers as the face's mark does, in every case", () => {
        const cases: Partial<KeepAwakeState>[] = [
            {},
            { automatic: true },
            { hold: true, automatic: true, automaticholding: true, automaticworking: true },
            { hold: true, coffees: [{ workspaceid: "ws1", since: 1, working: false }] },
            { attempts: [{ id: "1", blockid: "b", tool: "caffeinate", pid: 1, since: 0, outcome: "allowed" }] },
        ];
        for (const partial of cases) {
            setState(partial);
            const awake = keepAwakeActive(globalStore.get(model.stateAtom));
            expect(render()).toContain(`data-awake="${awake}"`);
        }
    });
});

describe("the two activation modes, Manual and Automatic (FR-BOSS-009, AC45)", () => {
    it("has a switch for each, each saying in one line what it does", () => {
        const html = render();
        expect(html.match(/role="switch"/g)).toHaveLength(2);
        expect(html).toContain("Keeps this computer awake for “Alpha” until you turn it off.");
        expect(html).toContain("Keeps this computer awake whenever an agent works anywhere, until it has finished.");
    });

    it("shows Manual on for the workspace whose Manual switch is on, whether or not it works", () => {
        setState({ hold: true, coffees: [{ workspaceid: "ws1", workspacename: "Alpha", since: 1, working: false }] });
        const html = render();
        expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Manual"/);
        expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Automatic"/);
        expect(text(html, "brokk-keepawake-cause")).toBe("Manual (Alpha)");
    });

    it("turns Manual on or off for the workspace the window shows, and Automatic through its setting", () => {
        const source = readFileSync(join(__dirname, "..", "keepawake-modes.tsx"), "utf8");
        expect(source).toContain("setCoffee(workspaceId, !manualOn)");
        expect(source).toContain("setAutomatic(!state.automatic)");
    });
});

describe("the reasons and the way to the configuration (FR-BOSS-009, AC46)", () => {
    it("lists what keeps the computer awake with the cup's Show and Stop, only while something does", () => {
        setState({ hold: true, automaticholding: true, automaticworking: true });
        const html = render();
        expect(html).toContain('data-testid="brokk-keepawake-reason"');
        expect(html).toContain('data-testid="mock-hold"');
        const source = readFileSync(join(__dirname, "brokk-keepawake-panel.tsx"), "utf8");
        expect(source).toContain("<HoldRow");
    });

    it("links to Preferences › Energy, and no longer offers the sleep policy", () => {
        const html = render();
        expect(html).toContain('data-testid="brokk-keepawake-more"');
        expect(html).toContain("More settings…");
        expect(html).not.toContain('role="radiogroup"');
        const source = readFileSync(join(__dirname, "brokk-keepawake-panel.tsx"), "utf8");
        expect(source).toContain('openSettingsKey("general", AutomaticSetting)');
    });

    it("keeps a panel where keep-awake does not exist, and says so without naming the system", () => {
        Hoisted.platform = "win32";
        const html = render();
        expect(html).toContain('data-testid="brokk-keepawake-unsupported"');
        expect(html).toContain("Keeping this computer awake is not available here.");
        expect(html).not.toContain('role="switch"');
    });
});
