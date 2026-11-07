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
vi.mock("../keepawake-cup", () => ({
    HoldRow: () => <li data-testid="mock-hold" />,
    PolicyChoices: () => <div data-testid="mock-policy" />,
}));
vi.mock("../settings/settings-open", () => ({ openSettingsKey: vi.fn() }));
vi.mock("../keepawake-store", async () => {
    const { atom } = await import("jotai");
    const stateAtom = atom({});
    const model = {
        stateAtom,
        coffeeAtom: () =>
            atom((get) => (get(stateAtom) as any).coffees.find((c: any) => c.workspaceid === "ws1") ?? null),
        setCoffee: vi.fn(),
    };
    return { KeepAwakeModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { EmptyKeepAwakeState, KeepAwakeState } from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { BrokkKeepAwakePanel } from "./brokk-keepawake-panel";

const model = KeepAwakeModel.getInstance() as any;

function setState(partial: Partial<KeepAwakeState>) {
    globalStore.set(model.stateAtom, { ...EmptyKeepAwakeState, version: 1, ...partial });
}

function render(): string {
    return renderToStaticMarkup(<BrokkKeepAwakePanel onLeave={() => {}} onClose={() => {}} />);
}

beforeEach(() => {
    Hoisted.platform = "darwin";
    setState({});
});

describe("the Garder éveillé panel opens the keep-awake line out (FR-BOSS-009, AC10 and AC19)", () => {
    it("has a switch named for the workspace, off while coffee mode is off, with the cup's idle words", () => {
        const html = render();
        expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Keep awake while “Alpha” works"/);
        expect(html).toContain("Not keeping this computer awake");
    });

    it("is on while coffee mode is on for the workspace the window shows", () => {
        setState({ coffees: [{ workspaceid: "ws1", since: 1, reason: "work", untilidle: true } as any] });
        expect(render()).toMatch(/role="switch" aria-checked="true"/);
    });

    it("says the reason: nothing keeps the computer awake, or what does, with the cup's Show and Stop", () => {
        const html = render();
        expect(html).toContain('data-testid="brokk-keepawake-reason"');
        expect(html).toContain("Nothing keeps this computer awake.");
        const source = readFileSync(join(__dirname, "brokk-keepawake-panel.tsx"), "utf8");
        expect(source).toContain("<HoldRow");
    });

    it("says it lasts until the work ends", () => {
        expect(render()).toContain("Until the work ends.");
    });

    it("offers the sleep policy and the link to Preferences, without a chevron to open first", () => {
        const html = render();
        expect(html).toContain('data-testid="mock-policy"');
        expect(html).toContain('data-testid="brokk-keepawake-more"');
        expect(html).not.toContain('data-testid="brokk-keepawake-details"');
        const source = readFileSync(join(__dirname, "brokk-keepawake-panel.tsx"), "utf8");
        expect(source).toContain('openSettingsKey("general", SleepPolicySetting)');
        expect(source).toContain("model.setCoffee(workspace.oid, !on)");
    });

    it("keeps a panel where coffee mode does not exist, and says so without naming the system", () => {
        Hoisted.platform = "win32";
        const html = render();
        expect(html).toContain('data-testid="brokk-keepawake-unsupported"');
        expect(html).toContain("Keeping this computer awake is not available here.");
        expect(html).not.toContain('role="switch"');
    });
});
