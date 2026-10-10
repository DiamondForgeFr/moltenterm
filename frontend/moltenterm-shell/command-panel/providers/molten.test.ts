// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    meta: {} as Record<string, unknown>,
    settings: {} as Record<string, unknown>,
    metaWrites: [] as Record<string, unknown>[],
    settingsWrites: [] as Record<string, unknown>[],
    rpc: [] as { command: string; data: unknown }[],
    durable: true as boolean,
    agents: {} as Record<string, { agent: string }>,
    companionOpen: false,
    reduced: false,
    project: "/p/moltenterm",
    remembered: {} as Record<string, number>,
    sets: [] as { atom: unknown; value: unknown }[],
}));

vi.mock("@/app/store/global", () => {
    const settingsAtom = { key: "settings" };
    const workspace = { key: "workspace" };
    const prefersReducedMotionAtom = { key: "reduced" };
    return {
        atoms: { settingsAtom, workspace, prefersReducedMotionAtom },
        getBlockMetaKeyAtom: (_blockId: string, key: string) => ({ key: `meta:${key}` }),
        getBlockTermDurableAtom: () => ({ key: "durable" }),
        globalStore: {
            get: (a: { key: string }) => {
                if (a.key === "settings") return state.settings;
                if (a.key === "durable") return state.durable;
                if (a.key === "reduced") return state.reduced;
                if (a.key === "workspace") return { meta: { "molten:project": state.project } };
                if (a.key?.startsWith("agent:")) return state.agents[a.key.slice(6)] ?? null;
                if (a.key?.startsWith("session:"))
                    return { path: "/s.jsonl", title: "Fix the build", linkedby: "auto" };
                return state.meta[a.key?.slice(5)];
            },
            set: (atom: unknown, value: unknown) => state.sets.push({ atom, value }),
        },
    };
});
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async (_c: unknown, data: { meta: Record<string, unknown> }) => {
            state.metaWrites.push(data.meta);
        },
        SetConfigCommand: async (_c: unknown, data: Record<string, unknown>) => {
            state.settingsWrites.push(data);
        },
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: async (command: string, data: unknown) => {
            state.rpc.push({ command, data });
        },
    },
}));
vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("../../agent-state-store", () => ({
    AgentStates: { getInstance: () => ({ blockAtom: (id: string) => ({ key: `agent:${id}` }) }) },
}));
vi.mock("../../companion/companion-session-store", () => ({
    CompanionSessions: { getInstance: () => ({ sessionAtom: (id: string) => ({ key: `session:${id}` }) }) },
}));
vi.mock("../../companion/companion-open", () => ({
    findCompanionBlock: () => (state.companionOpen ? "c1" : null),
    toggleCompanion: vi.fn(async () => {}),
}));
vi.mock("../../mission/line-map-store", () => ({
    rememberedLineMapDays: (dir: string) => state.remembered[dir],
    rememberLineMapDays: (dir: string, _full: boolean, days: number) => {
        state.remembered[dir] = days;
    },
}));
vi.mock("../../shortcuts/format", () => ({ formatShortcutById: (id: string) => (id === "companion" ? "⌘⇧J" : "") }));

import { toggleCompanion } from "../../companion/companion-open";
import { activeScope, canReset, effectiveValue, resetItem, setItemValue } from "../panel-model";
import { collectPanel } from "../panel-registry";
import { PanelContext, PanelItem, PanelSection } from "../panel-types";
import { MoltenProvider, MoltenProviders } from "./molten";
import { companionSections, lineMapSections, sessionsSections } from "./molten-widgets";

function ctx(view: string, caps: string[], extra: Partial<PanelContext> = {}): PanelContext {
    return {
        blockId: "b1",
        view,
        meta: {},
        viewModel: { restartSessionWithDurability: vi.fn(async () => {}) } as any,
        capabilities: new Set([`view:${view}`, ...caps]),
        agent: null,
        kindLabel: "panels",
        panelName: view,
        ...extra,
    };
}

function find(sections: PanelSection[], id: string): any {
    for (const s of sections) {
        const item = s.items.find((i: PanelItem) => i.id === id);
        if (item != null) {
            return item;
        }
    }
    return null;
}

beforeEach(() => {
    state.meta = {};
    state.settings = {};
    state.metaWrites = [];
    state.settingsWrites = [];
    state.rpc = [];
    state.durable = true;
    state.agents = {};
    state.companionOpen = false;
    state.reduced = false;
    state.remembered = {};
    state.sets = [];
});

describe("MoltenTerm section (FR-SHELL-049-AC1, DS-SHELL-089, TC-SHELL-107)", () => {
    it("shows the shipped items of a terminal running an agent and none of the unshipped ones", () => {
        const panel = collectPanel(ctx("term", ["terminal", "agent", "agent:claude"]), [MoltenProvider]);
        expect(panel.sections.map((s) => [s.kind, s.title])).toEqual([["molten", "MoltenTerm"]]);
        const labels = panel.sections[0].items.map((i) => i.label);
        expect(labels).toEqual(["Open the companion", "Durable session"]);
        // Absent, not disabled, until #386, #331, #322 and the morph flow ship.
        for (const absent of ["Auto-approve", "Continue with", "Agent integration", "Morph", "workspace task"]) {
            expect(labels.some((l) => l.includes(absent))).toBe(false);
        }
        expect(panel.sections[0].items.some((i) => i.disabled)).toBe(false);
    });

    it("matches terminals only, and offers the companion only with an agent", () => {
        expect(collectPanel(ctx("preview", []), [MoltenProvider]).sections).toEqual([]);
        const plain = collectPanel(ctx("term", ["terminal"]), [MoltenProvider]);
        expect(plain.sections[0].items.map((i) => i.label)).toEqual(["Durable session"]);
    });

    it("toggles the companion with its shortcut and says Close once it is open", () => {
        state.companionOpen = true;
        const [section] = MoltenProvider.sections(ctx("term", ["terminal", "agent"]));
        const item = find([section], "molten:companion");
        expect(item.label).toBe("Close the companion");
        expect(item.shortcut).toBe("⌘⇧J");
        item.run();
        expect(toggleCompanion).toHaveBeenCalledWith("b1");
    });

    it("opens a durable session's page that restarts the shell the other way, and hides it when unknown", () => {
        const c = ctx("term", ["terminal"]);
        const page = find(MoltenProvider.sections(c), "molten:durable");
        expect(page.type).toBe("page");
        expect(page.detail).toBe("On");
        const restart = page.items.find((i: PanelItem) => i.type === "action");
        expect(restart.label).toBe("Restart as a standard session");
        expect(restart.destructive).toBe(true);
        restart.run();
        expect((c.viewModel as any).restartSessionWithDurability).toHaveBeenCalledWith(false);
        state.durable = null;
        expect(find(MoltenProvider.sections(c), "molten:durable")).toBeNull();
    });
});

describe("MoltenTerm widget options (FR-SHELL-049-AC4..AC6, DS-SHELL-090, TC-SHELL-108)", () => {
    it("gives every MoltenTerm widget its own section, not only block actions", () => {
        state.agents.t1 = { agent: "claude" };
        const views: [string, string[]][] = [
            ["molten-companion", []],
            ["molten-linemap", []],
            ["molten-cicd", []],
            ["molten-project", []],
            ["molten-timeline", []],
            ["molten-sessions", []],
        ];
        for (const [view, caps] of views) {
            const c = ctx(view, caps, { meta: { "molten:companion:block": "t1" } as MetaType });
            const panel = collectPanel(c, MoltenProviders);
            expect(panel.sections.filter((s) => s.kind === "widget").length, view).toBe(1);
            expect(
                panel.sections.some((s) => s.kind === "molten"),
                view
            ).toBe(false);
        }
    });

    it("turns the companion's plan usage on and off for its agent through wavesrv, Everywhere", async () => {
        state.agents.t1 = { agent: "claude" };
        const c = ctx("molten-companion", [], { meta: { "molten:companion:block": "t1" } as MetaType });
        let usage = find(companionSections(c), "companion:usage");
        expect(usage.detail).toBe("Claude Code");
        expect(effectiveValue(usage)).toBe(false);
        expect(activeScope(usage).scope).toBe("global");
        expect(find(companionSections(c), "companion:usagesource")).toBeNull();
        await setItemValue(usage, true);
        expect(state.rpc).toEqual([{ command: "moltencompanionusagegauges", data: { blockid: "t1", on: true } }]);

        state.settings["companion:usagegauges"] = ["claude"];
        usage = find(companionSections(c), "companion:usage");
        expect(effectiveValue(usage)).toBe(true);
        expect(canReset(usage)).toBe(true);
        await resetItem(usage);
        expect(state.rpc.at(-1)).toEqual({ command: "moltencompanionusagegauges", data: { blockid: "t1", on: false } });
    });

    it("picks Claude Code's usage source while its gauges show; Codex has none to pick", async () => {
        state.agents.t1 = { agent: "claude" };
        state.settings["companion:usagegauges"] = ["claude", "codex"];
        const c = ctx("molten-companion", [], { meta: { "molten:companion:block": "t1" } as MetaType });
        const source = find(companionSections(c), "companion:usagesource");
        expect(source.options.map((o: any) => o.label)).toEqual(["Status line", "Status line and usage endpoint"]);
        expect(effectiveValue(source)).toBe(false);
        await setItemValue(source, true);
        expect(state.rpc.at(-1)).toEqual({
            command: "moltencompanionusageexperimental",
            data: { blockid: "t1", on: true },
        });
        state.agents.t1 = { agent: "codex" };
        expect(find(companionSections(c), "companion:usagesource")).toBeNull();
        expect(find(companionSections(c), "companion:usage")).not.toBeNull();
    });

    it("opens the companion's session picker from Linked session, naming the session", () => {
        state.agents.t1 = { agent: "claude" };
        const historyAtom = { key: "history" };
        const c = ctx("molten-companion", [], {
            meta: { "molten:companion:block": "t1" } as MetaType,
            viewModel: { historyAtom } as any,
        });
        const item = find(companionSections(c), "companion:session");
        expect(item.detail).toBe("Fix the build");
        item.run();
        expect(state.sets).toEqual([{ atom: historyAtom, value: true }]);
    });

    it("leaves the companion's options out until it follows a terminal with an agent", () => {
        expect(companionSections(ctx("molten-companion", []))).toEqual([]);
        const c = ctx("molten-companion", [], {
            meta: { "molten:companion:block": "t1" } as MetaType,
            viewModel: { historyAtom: {} } as any,
        });
        expect(companionSections(c)[0].items).toEqual([]);
    });

    it("sets the line map's window for this panel or this project, and its animation for all line maps", async () => {
        const c = ctx("molten-linemap", []);
        const [section] = lineMapSections(c);
        const days = find([section], "linemap:days");
        expect(days.scopes.map((s: any) => s.scope)).toEqual(["panel", "project"]);
        expect(effectiveValue(days)).toBe(60);
        await setItemValue(days, 30, "project");
        expect(state.remembered["/p/moltenterm"]).toBe(30);
        expect(effectiveValue(days)).toBe(30);
        await setItemValue(days, 14, "panel");
        expect(state.metaWrites).toEqual([{ "linemap:days": 14 }]);

        const animation = find([section], "linemap:animation");
        expect(animation.scopes.map((s: any) => s.scope)).toEqual(["panel", "kind"]);
        await setItemValue(animation, false, "kind");
        expect(state.settingsWrites).toEqual([{ "linemap:animation": false }]);
        state.settings["linemap:animation"] = false;
        expect(effectiveValue(animation)).toBe(false);
        expect(canReset(animation, "kind")).toBe(true);
    });

    it("says when reduced motion holds the line map still, and has no project scope without a project", () => {
        state.reduced = true;
        state.project = "";
        const [section] = lineMapSections(ctx("molten-linemap", []));
        expect(find([section], "linemap:animation").detail).toBe("off while the system reduces motion");
        expect(find([section], "linemap:days").scopes.map((s: any) => s.scope)).toEqual(["panel"]);
        state.project = "/p/moltenterm";
    });

    it("chooses the CI/CD runs at both scopes and the Project branches for this panel", async () => {
        const cicd = find(collectPanel(ctx("molten-cicd", []), MoltenProviders).sections, "cicd:runs");
        expect(cicd.options.map((o: any) => o.value)).toEqual(["local", "remote", "cd"]);
        expect(effectiveValue(cicd)).toBe("remote");
        await setItemValue(cicd, "local", "kind");
        expect(state.settingsWrites).toEqual([{ "cicd:runs": "local" }]);

        const branches = find(collectPanel(ctx("molten-timeline", []), MoltenProviders).sections, "project:branches");
        expect(branches.scopes.map((s: any) => s.scope)).toEqual(["panel"]);
        await setItemValue(branches, "open");
        expect(state.metaWrites).toEqual([{ "project:branches": "open" }]);
    });

    it("keeps the Sessions filters on this panel, each with a reset", async () => {
        const [section] = sessionsSections(ctx("molten-sessions", []));
        expect(section.title).toBe("Filters");
        expect(section.items.map((i) => i.label)).toEqual(["Agent", "Folder", "State"]);
        const agent = find([section], "sessions:agent");
        expect(agent.scopes.map((s: any) => s.scope)).toEqual(["panel"]);
        state.meta["sessions:agent"] = "claude";
        expect(canReset(agent)).toBe(true);
        await resetItem(agent);
        expect(state.metaWrites).toEqual([{ "sessions:agent": null }]);
    });
});
