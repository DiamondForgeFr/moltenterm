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
import { BrokkKeepAwakeLine } from "./brokk-keepawake-line";

const model = KeepAwakeModel.getInstance() as any;

function setState(partial: Partial<KeepAwakeState>) {
    globalStore.set(model.stateAtom, { ...EmptyKeepAwakeState, version: 1, ...partial });
}

function render(): string {
    return renderToStaticMarkup(<BrokkKeepAwakeLine onLeave={() => {}} />);
}

beforeEach(() => {
    Hoisted.platform = "darwin";
    setState({});
});

describe("the keep-awake line replaces the cup (FR-BOSS-009, AC9, AC10)", () => {
    it("is a switch named for the workspace, off while coffee mode is off, with the cup's idle words", () => {
        const html = render();
        expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Keep awake while “Alpha” works"/);
        expect(html).toContain("Not keeping this computer awake");
    });

    it("is on while coffee mode is on for the workspace the window shows", () => {
        setState({
            coffees: [{ workspaceid: "ws1", since: 1, reason: "work", untilidle: true } as any],
        });
        expect(render()).toMatch(/role="switch" aria-checked="true"/);
    });

    it("offers the details of the cup's menu: what holds the computer awake, the sleep policy and the link to Preferences", () => {
        const html = render();
        expect(html).toContain('data-testid="brokk-keepawake-details"');
        expect(html).toContain('aria-expanded="false"');
        const source = readFileSync(join(__dirname, "brokk-keepawake-line.tsx"), "utf8");
        for (const part of ["<HoldRow", "<PolicyChoices />", 'openSettingsKey("general", SleepPolicySetting)']) {
            expect(source, part).toContain(part);
        }
        expect(source).toContain("model.setCoffee(workspace.oid, !on)");
    });

    it("says nothing where coffee mode does not exist", () => {
        Hoisted.platform = "win32";
        expect(render()).toBe("");
    });
});
