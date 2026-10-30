// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import type { CompanionSubagent, CompanionView } from "../companion/companion-model";
import { subagentCardGroups, subagentGroups, subagentRows } from "./agent-info-model";
import { AgentInfoModel } from "./agent-info-store";
import { SubagentsSection } from "./subagents-section";

const Info = { blockid: "b1", state: "idle" } as AgentStateInfo;
const Now = Date.now();
const Hour = 3_600_000;

function view(subagents: CompanionSubagent[]): CompanionView {
    return { blockid: "b1", version: 1, status: "ok" as any, subagents };
}

function sub(id: string, state: CompanionSubagent["state"], ended = 0): CompanionSubagent {
    return { id, description: `Task ${id}`, kind: "worker", state, started: Now - 2 * Hour, ended };
}

function html(subagents: CompanionSubagent[]): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <SubagentsSection blockId="b1" info={Info} companion={view(subagents)} />
        </Provider>
    );
}

beforeEach(() => globalStore.set(AgentInfoModel.getInstance().seenSubsAtom, {}));

describe("SubagentsSection (#1542)", () => {
    it("draws nothing without sub-agents", () => {
        expect(html([])).toBe("");
    });

    it("lists the running ones, then one collapsed line for the finished ones, never their rows", () => {
        const out = html([
            sub("d1", "done", Now - Hour),
            sub("r1", "running"),
            sub("d2", "done", Now - 2 * Hour),
            sub("d3", "stopped", Now - 3 * Hour),
        ]);
        expect(out.match(/data-testid="agent-info-sub"/g)).toHaveLength(1);
        expect(out).toContain("Task r1");
        expect(out).not.toContain("Task d1");
        expect(out).toMatch(/data-testid="agent-info-subs-done"[^>]*>.*Done (today )?· 3/);
        expect(out).toContain('aria-expanded="false"');
    });

    it("keeps a failure not yet seen as a row, and folds it once seen", () => {
        const subs = [sub("f1", "failed", Now - Hour), sub("d1", "done", Now - Hour)];
        expect(html(subs)).toContain("Task f1");
        expect(html(subs)).toMatch(/Done (today )?· 1/);
        AgentInfoModel.getInstance().markSubSeen(
            "b1",
            subagentRows(view(subs)).find((r) => r.id === "f1")
        );
        expect(html(subs)).not.toContain("Task f1");
        expect(html(subs)).toMatch(/Done (today )?· 2/);
    });

    it("has no clear action", () => {
        expect(html([sub("d1", "done", Now - Hour)])).not.toMatch(/clear/i);
    });
});

describe("markSubSeen (#1542)", () => {
    it("remembers a sub-agent per terminal and ignores empty ids", () => {
        const model = AgentInfoModel.getInstance();
        const row = subagentRows(view([sub("x", "failed", Now)]))[0];
        model.markSubSeen("b1", row);
        model.markSubSeen("", row);
        model.markSubSeen("b2", null);
        expect(globalStore.get(model.seenSubsAtom)).toEqual({ b1: { x: `${row.started}:${row.ended}` } });
    });

    it("keeps a later failure visible after opening and closing a running subagent", () => {
        const model = AgentInfoModel.getInstance();
        model.openSub("b1", "z");
        model.closeSub();
        const row = subagentRows(view([sub("z", "failed", Now)]))[0];
        const seen = globalStore.get(model.seenSubsAtom).b1;
        expect(subagentGroups([row], Now, false, seen).lingering).toEqual([row]);
        expect(subagentCardGroups([row], seen).unseen).toEqual([row]);
        model.markSubSeen("b1", row);
        expect(subagentGroups([row], Now, false, globalStore.get(model.seenSubsAtom).b1).lingering).toEqual([]);
        const later = { ...row, ended: Now + 1 };
        expect(subagentGroups([later], Now + 1, false, globalStore.get(model.seenSubsAtom).b1).lingering).toEqual([
            later,
        ]);
    });

    it("acknowledges the failure arriving while the card remains open, not its running state", () => {
        const model = AgentInfoModel.getInstance();
        const running = subagentRows(view([sub("z", "running")]))[0];
        model.openSub("b1", "z");
        model.markSubSeen("b1", running);
        expect(globalStore.get(model.seenSubsAtom).b1).toBeUndefined();
        const failed = { ...running, state: "error" as const, ended: Now };
        model.markSubSeen("b1", failed);
        expect(subagentCardGroups([failed], globalStore.get(model.seenSubsAtom).b1).unseen).toEqual([]);
        expect(globalStore.get(model.openSubAtom)).toEqual({ blockId: "b1", id: "z" });
        model.closeSub();
    });

    it("persists a failure occurrence across a model restart and ignores legacy generic seen flags", () => {
        const stored = new Map<string, string>([["molten:sidebar:seensubs", JSON.stringify({ b1: { z: true } })]]);
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => stored.set(key, value),
        });
        try {
            (AgentInfoModel as any).instance = null;
            const first = AgentInfoModel.getInstance();
            const row = subagentRows(view([sub("z", "failed", Now)]))[0];
            expect(subagentCardGroups([row], globalStore.get(first.seenSubsAtom).b1).unseen).toEqual([row]);
            first.markSubSeen("b1", row);
            (AgentInfoModel as any).instance = null;
            const restarted = AgentInfoModel.getInstance();
            expect(subagentCardGroups([row], globalStore.get(restarted.seenSubsAtom).b1).unseen).toEqual([]);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
