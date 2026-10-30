// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import type { CompanionSubagent, CompanionView } from "../companion/companion-model";
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
        AgentInfoModel.getInstance().markSubSeen("b1", "f1");
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
        model.markSubSeen("b1", "x");
        model.markSubSeen("", "y");
        model.markSubSeen("b2", "");
        expect(globalStore.get(model.seenSubsAtom)).toEqual({ b1: { x: true } });
    });

    it("marks a sub-agent seen when its card opens", () => {
        const model = AgentInfoModel.getInstance();
        model.openSub("b1", "z");
        expect(globalStore.get(model.seenSubsAtom).b1?.z).toBe(true);
        model.closeSub();
    });
});
