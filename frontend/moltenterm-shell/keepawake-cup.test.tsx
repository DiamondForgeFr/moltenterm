// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom, getDefaultStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Hoisted = vi.hoisted(() => ({ policy: "", coffee: null as unknown }));

vi.mock("@/app/store/global", async () => {
    const { atom: makeAtom } = await import("jotai");
    return {
        useSettingsKeyAtom: () => Hoisted.policy,
        atoms: { workspace: makeAtom({ oid: "ws1", name: "Alpha" }) },
    };
});
vi.mock("@/util/platformutil", () => ({ PLATFORM: "darwin" }));
vi.mock("./command-panel/bindings", () => ({ writeSettings: vi.fn() }));
vi.mock("./settings/settings-open", () => ({ openSettingsKey: vi.fn() }));
vi.mock("./mission/menu-popover", () => ({
    MenuPopover: ({ children }: { children: React.ReactNode }) => <div data-testid="menu-popover">{children}</div>,
}));
vi.mock("./keepawake-store", async () => {
    const { atom: makeAtom } = await import("jotai");
    const stateAtom = makeAtom({});
    const model = {
        stateAtom,
        coffeeAtom: () => makeAtom((get) => (get(stateAtom) as any).coffees.find((c: any) => c.workspaceid === "ws1") ?? null),
        setCoffee: vi.fn(),
        setOverride: vi.fn(),
    };
    return { KeepAwakeModel: { getInstance: () => model } };
});

import { KeepAwakePopover, KeepAwakeStatusItem } from "./keepawake-cup";
import { EmptyKeepAwakeState, KeepAwakeAttempt, KeepAwakeState } from "./keepawake-model";
import { KeepAwakeModel } from "./keepawake-store";

const model = KeepAwakeModel.getInstance() as unknown as { stateAtom: ReturnType<typeof atom> };

function setState(partial: Partial<KeepAwakeState>) {
    getDefaultStore().set(model.stateAtom as any, { ...EmptyKeepAwakeState, version: 1, ...partial });
}

function attempt(partial: Partial<KeepAwakeAttempt>): KeepAwakeAttempt {
    return { id: "1", blockid: "b1", tool: "caffeinate", pid: 10, since: 0, outcome: "allowed", ...partial };
}

function item(variant: "status" | "sidebar" = "sidebar") {
    return renderToStaticMarkup(<KeepAwakeStatusItem variant={variant} />);
}

beforeEach(() => {
    Hoisted.policy = "";
    setState({});
});

describe("keep-awake cup (FR-SHELL-103, #1408)", () => {
    it("stays in the window row while nothing keeps the computer awake, calm and not pressed", () => {
        for (const html of [item(), item("status")]) {
            expect(html).toContain("fa-mug-hot");
            expect(html).toContain('aria-pressed="false"');
            expect(html).toContain("text-muted");
            expect(html).not.toContain("data-lit");
        }
        setState({ attempts: [attempt({ outcome: "neutralised" })] });
        expect(item()).not.toContain("data-lit");
    });

    it("is a toggle named for the workspace, pressed while its coffee is on and lit while something holds", () => {
        setState({ hold: true, coffees: [{ workspaceid: "ws1", workspacename: "Alpha", since: 1, working: true }] });
        const html = item();
        expect(html).toContain('aria-label="Keep awake while “Alpha” works"');
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain("data-lit");
        expect(html).not.toContain("fa-moon");
    });

    it("is lit but not pressed when only a terminal holds: a click turns this workspace's coffee on", () => {
        setState({ attempts: [attempt({})] });
        const html = item();
        expect(html).toContain("data-lit");
        expect(html).toContain('aria-pressed="false"');
    });

    it("says what a click and a right click do, the reason and the setting in its tooltip", () => {
        Hoisted.policy = "untilworkends";
        setState({ attempts: [attempt({})] });
        const html = item();
        expect(html).toContain("Keeping this computer awake: a terminal asked to stay awake");
        expect(html).toContain("Energy setting: Until work ends");
        expect(html).toContain("Click: on/off · Right-click: options");
        expect(html).not.toContain("Open Preferences");
    });

    it("opens a popover on its own, never Preferences (it carries a dialog hint, no link)", () => {
        const html = item();
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain("<button");
        expect(html).not.toContain("<a ");
    });

    it("counts only when more than one thing keeps it awake", () => {
        setState({ attempts: [attempt({})] });
        expect(item()).not.toContain("tabular-nums");
        setState({ hold: true, coffees: [{ workspaceid: "a", since: 1, working: true }], attempts: [attempt({})] });
        expect(item()).toContain(">2<");
    });
});

describe("keep-awake popover (FR-SHELL-103, #1408)", () => {
    const popover = () => renderToStaticMarkup(<KeepAwakePopover anchor={{} as Element} onClose={() => {}} />);

    it("offers the four options of Preferences › Energy with the same labels, the current one selected", () => {
        Hoisted.policy = "untilworkends";
        const html = popover();
        for (const label of ["Ask the first time", "When a terminal asks", "Until work ends", "Never"]) {
            expect(html).toContain(label);
        }
        expect(html).toContain('role="radiogroup"');
        expect(html).toMatch(/data-option="untilworkends"[^>]*>|data-selected=""[^>]*data-option="untilworkends"/);
    });

    it("says nothing holds the computer awake, and lists the coffees with Stop", () => {
        expect(popover()).toContain("Not keeping this computer awake");
        setState({ hold: true, coffees: [{ workspaceid: "a", workspacename: "Beta", since: 1, working: true }] });
        const html = popover();
        expect(html).toContain("Stop keeping this computer awake for Beta");
        expect(html).toContain(">Stop<");
    });

    it("links to Preferences only through a discreet More settings button", () => {
        const html = popover();
        expect(html).toContain('data-testid="keepawake-more-settings"');
        expect(html).toContain("More settings…");
    });
});
