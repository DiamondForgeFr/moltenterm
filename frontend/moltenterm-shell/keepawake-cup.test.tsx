// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, getDefaultStore } from "jotai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
vi.mock("./review/review-panels", () => ({ showPanel: vi.fn() }));
vi.mock("./mission/menu-popover", () => ({
    MenuPopover: ({ children }: { children: React.ReactNode }) => <div data-testid="menu-popover">{children}</div>,
}));
vi.mock("./keepawake-store", async () => {
    const { atom: makeAtom } = await import("jotai");
    const stateAtom = makeAtom({});
    const model = {
        stateAtom,
        coffeeAtom: () =>
            makeAtom((get) => (get(stateAtom) as any).coffees.find((c: any) => c.workspaceid === "ws1") ?? null),
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
            expect(html).toContain('data-testid="keepawake-cup-icon"');
            expect(html).toContain('aria-pressed="false"');
            expect(html).toContain("text-muted");
            expect(html).not.toContain("data-lit");
            expect(html).not.toContain("data-on");
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

    it("shows coffee mode on by the icon itself (coloured, steaming), never by a background (#1470)", () => {
        setState({ hold: true, coffees: [{ workspaceid: "ws1", workspacename: "Alpha", since: 1, working: true }] });
        for (const html of [item(), item("status")]) {
            expect(html).toMatch(/class="mt-cup [^"]*"[^>]*data-on=""/);
            expect(html.match(/mt-cup-steam mt-cup-steam-/g)).toHaveLength(3);
            expect(html).not.toMatch(/<button[^>]*class="([^"]* )?bg-hover[ "]/);
        }
        setState({});
        expect(item()).not.toContain("data-on");
    });

    it("starts its tooltip with the state of coffee mode (#1470)", () => {
        setState({ hold: true, coffees: [{ workspaceid: "ws1", workspacename: "Alpha", since: 1, working: true }] });
        expect(item()).toContain('title="Coffee mode on · 1 reason keeps this computer awake');
        setState({});
        expect(item()).toContain('title="Coffee mode off · Not keeping this computer awake');
    });

    it("does not show on when only something else holds: the icon is not coloured, a click turns coffee on", () => {
        setState({ attempts: [attempt({})] });
        expect(item()).not.toContain("data-on");
    });

    it("keeps the steam's motion cheap and still under reduced motion (DS-SHELL-151, #1470)", () => {
        const css = readFileSync(join(__dirname, "keepawake-cup.css"), "utf8");
        expect(css).toMatch(/\.mt-cup\[data-on\] \{\s*color: var\(--mt-state-running\);/);
        expect(css).not.toContain("--mt-action");
        expect(css).not.toMatch(/@container|container-type/);
        const motion = css.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}\n/)?.[1] ?? "";
        expect(motion).toContain("animation-duration: 4s;");
        expect(motion).toContain("animation-timing-function: steps(30);");
        expect(motion).toContain("animation-delay: 0s;");
        for (const i of [1, 2, 3]) {
            expect(motion).toContain(`animation-name: mt-cup-steam-${i};`);
            expect(css).toContain(`@keyframes mt-cup-steam-${i} {`);
        }
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-cup\[data-on\] \.mt-cup-steam,[^{]*\{\s*animation: none;/);
        const keyframes = css.slice(css.indexOf("@keyframes"));
        expect(keyframes.replace(/transform|opacity/g, "")).not.toMatch(/\b(top|left|width|height|margin|filter)\s*:/);
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
        expect(html).toContain("Coffee mode off · 1 reason keeps this computer awake\n• A terminal · caffeinate");
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

    it("counts only when more than one reason keeps it awake, the number the tooltip and the menu give (#1780)", () => {
        setState({ attempts: [attempt({})] });
        expect(item()).not.toContain('data-testid="keepawake-count"');
        setState({
            hold: true,
            coffees: [{ workspaceid: "a", since: 1, working: true }],
            policyholding: true,
            attempts: [attempt({})],
        });
        for (const html of [item(), item("status")]) {
            expect(html).toMatch(/data-testid="keepawake-count"[^>]*>3</);
            expect(html).toContain("3 reasons keep this computer awake");
        }
        const menu = renderToStaticMarkup(<KeepAwakePopover anchor={{} as Element} onClose={() => {}} />);
        expect(menu).toContain("3 reasons keep this computer awake");
        expect(menu.match(/data-testid="keepawake-hold"/g)).toHaveLength(3);
    });

    it("writes the count as calm text to the left of the cup, never a badge (#1780)", () => {
        setState({ hold: true, coffees: [{ workspaceid: "a", since: 1, working: true }], attempts: [attempt({})] });
        for (const html of [item(), item("status")]) {
            const count = html.indexOf('data-testid="keepawake-count"');
            expect(count).toBeGreaterThan(-1);
            expect(count).toBeLessThan(html.indexOf('data-testid="keepawake-cup-icon"'));
            const span = html.slice(html.lastIndexOf("<span", count), html.indexOf(">", count));
            expect(span).toContain("text-muted");
            expect(span).not.toMatch(/rounded-full|absolute|bg-/);
        }
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

    it("says once why the computer is kept awake, naming the agent by its first name only (#1550)", () => {
        setState({ hold: true, policyholding: true, policyworking: true, policyreasons: ["Adrien: working"] });
        const html = popover();
        expect(html).toContain("1 reason keeps this computer awake");
        expect(html).toContain("until the work ends: Adrien: working");
        expect(html).not.toContain("Holding this computer awake");
        expect(html.match(/Adrien/g)).toHaveLength(2);
        expect(html).not.toContain("Claude Code");
    });

    it("lists one row per reason with its actions: Show and Stop on a terminal, Stop on a coffee, none on the setting (#1780)", () => {
        const now = 5_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        setState({
            hold: true,
            attempts: [
                attempt({
                    blockid: "b1",
                    tabname: "Scoping",
                    args: ["-i", "-t", "600"],
                    endsat: now + 600_000,
                    stoppable: true,
                }),
            ],
            coffees: [{ workspaceid: "a", workspacename: "Beta", since: 1, working: true }],
            policyholding: true,
            policyworking: true,
        });
        const html = popover();
        const rows = html.split('data-testid="keepawake-hold"').slice(1);
        expect(rows).toHaveLength(3);
        expect(rows[0]).toContain("Terminal in “Scoping”");
        expect(rows[0]).toContain("caffeinate -i -t 600 · 10 min left");
        expect(rows[0]).toContain(">Show<");
        expect(rows[0]).toContain('aria-label="Stop keeping this computer awake from Terminal in “Scoping”"');
        expect(rows[1]).toContain("Stop keeping this computer awake for Beta");
        expect(rows[1]).not.toContain(">Show<");
        expect(rows[2]).toContain("MoltenTerm");
        expect(rows[2]).not.toContain(">Stop<");
        expect(html).not.toContain("a terminal asked to stay awake");
        vi.restoreAllMocks();
    });

    it("links to Preferences only through a discreet More settings button", () => {
        const html = popover();
        expect(html).toContain('data-testid="keepawake-more-settings"');
        expect(html).toContain("More settings…");
    });
});
