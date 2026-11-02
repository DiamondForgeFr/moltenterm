// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom, getDefaultStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Hoisted = vi.hoisted(() => ({ policy: "" }));

vi.mock("@/app/store/global", async () => {
    const { atom: makeAtom } = await import("jotai");
    return {
        useSettingsKeyAtom: () => Hoisted.policy,
        atoms: { workspace: makeAtom({ oid: "ws1", name: "Alpha" }) },
    };
});
vi.mock("@/util/platformutil", () => ({ PLATFORM: "darwin" }));
vi.mock("./settings/settings-open", () => ({ openSettingsKey: vi.fn() }));
vi.mock("./keepawake-store", async () => {
    const { atom: makeAtom } = await import("jotai");
    const stateAtom = makeAtom({});
    const model = { stateAtom, coffeeAtom: () => makeAtom(null), setCoffee: vi.fn(), setOverride: vi.fn() };
    return { KeepAwakeModel: { getInstance: () => model } };
});

import { EmptyKeepAwakeState, KeepAwakeAttempt, KeepAwakeState } from "./keepawake-model";
import { KeepAwakeDetails } from "./keepawake-ui";
import { KeepAwakeModel } from "./keepawake-store";

const model = KeepAwakeModel.getInstance() as unknown as { stateAtom: ReturnType<typeof atom> };

function setState(partial: Partial<KeepAwakeState>) {
    getDefaultStore().set(model.stateAtom as any, { ...EmptyKeepAwakeState, version: 1, ...partial });
}

function attempt(partial: Partial<KeepAwakeAttempt>): KeepAwakeAttempt {
    return { id: "1", blockid: "b1", tool: "caffeinate", pid: 10, since: 0, outcome: "allowed", ...partial };
}

beforeEach(() => {
    Hoisted.policy = "";
    setState({});
});

describe("Energy card details (FR-SHELL-103)", () => {
    it("says what the chosen option does, and offers this workspace's coffee", () => {
        Hoisted.policy = "allow";
        const html = renderToStaticMarkup(<KeepAwakeDetails />);
        expect(html).toContain("A terminal that asks to stay awake is always heard.");
        expect(html).toContain('role="switch"');
        expect(html).toContain("Keep awake while “Alpha” works");
    });

    it("keeps the terminals that asked, each with its own override", () => {
        setState({ attempts: [attempt({ tabname: "Tab 1" })] });
        const html = renderToStaticMarkup(<KeepAwakeDetails />);
        expect(html).toContain("Terminals that asked");
        expect(html).toContain("Allow for this session");
        expect(html).toContain("caffeinate");
    });

    it("keeps the coffees with Stop", () => {
        setState({ hold: true, coffees: [{ workspaceid: "a", workspacename: "Beta", since: 1, working: true }] });
        const html = renderToStaticMarkup(<KeepAwakeDetails />);
        expect(html).toContain("Kept awake by you");
        expect(html).toContain("Stop keeping this computer awake for Beta");
    });
});
