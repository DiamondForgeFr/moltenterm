// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getBlockMetaKeyAtom: (await import("./block-meta-fake")).fakeBlocks.getBlockMetaKeyAtom,
}));
vi.mock("@/app/store/wshclientapi", async () => ({ RpcApi: (await import("./block-meta-fake")).fakeBlocks.rpc }));

import type { AgentStateInfo } from "../agent-state-model";
import type { CompanionSubagent, CompanionView } from "../companion/companion-model";
import { subagentCardGroups, subagentGroups, subagentRows } from "./agent-info-model";
import { AgentInfoModel } from "./agent-info-store";
import { fakeBlocks as fake } from "./block-meta-fake";
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

beforeEach(() => {
    fake.reset();
    fake.set("b1", { view: "term" });
    fake.set("b2", { view: "term" });
    AgentInfoModel.resetInstance();
});

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
        expect(globalStore.get(model.seenAtom("b1"))).toEqual({ x: `${row.started}:${row.ended}` });
        expect(globalStore.get(model.seenAtom("b2"))).toEqual({});
    });

    it("keeps a later failure visible after opening and closing a running subagent", () => {
        const model = AgentInfoModel.getInstance();
        model.openSub("b1", "z");
        model.closeSub();
        const row = subagentRows(view([sub("z", "failed", Now)]))[0];
        const seen = globalStore.get(model.seenAtom("b1"));
        expect(subagentGroups([row], Now, false, seen).lingering).toEqual([row]);
        expect(subagentCardGroups([row], seen).unseen).toEqual([row]);
        model.markSubSeen("b1", row);
        expect(subagentGroups([row], Now, false, globalStore.get(model.seenAtom("b1"))).lingering).toEqual([]);
        const later = { ...row, ended: Now + 1 };
        expect(subagentGroups([later], Now + 1, false, globalStore.get(model.seenAtom("b1"))).lingering).toEqual([
            later,
        ]);
    });

    it("acknowledges the failure arriving while the card remains open, not its running state", () => {
        const model = AgentInfoModel.getInstance();
        const running = subagentRows(view([sub("z", "running")]))[0];
        model.openSub("b1", "z");
        model.markSubSeen("b1", running);
        expect(globalStore.get(model.seenAtom("b1"))).toEqual({});
        const failed = { ...running, state: "error" as const, ended: Now };
        model.markSubSeen("b1", failed);
        expect(subagentCardGroups([failed], globalStore.get(model.seenAtom("b1"))).unseen).toEqual([]);
        expect(globalStore.get(model.openSubAtom)).toEqual({ blockId: "b1", id: "z" });
        model.closeSub();
    });

    it("persists a failure occurrence across a model restart and ignores legacy generic seen flags", async () => {
        fake.set("b1", { "molten:sidebar:seensubs": { z: true } });
        const first = AgentInfoModel.getInstance();
        const row = subagentRows(view([sub("z", "failed", Now)]))[0];
        expect(subagentCardGroups([row], globalStore.get(first.seenAtom("b1"))).unseen).toEqual([row]);
        first.markSubSeen("b1", row);
        await Promise.resolve();
        AgentInfoModel.resetInstance();
        const restarted = AgentInfoModel.getInstance();
        expect(subagentCardGroups([row], globalStore.get(restarted.seenAtom("b1"))).unseen).toEqual([]);
    });
});
