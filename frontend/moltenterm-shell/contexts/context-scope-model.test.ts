// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { InfoItem, ToHandleItem, ToHandleList } from "../boss/boss-to-handle-model";
import { ContextScopeFacts, EmptyScopeFacts, rowInContext, scopeAgents, scopeToHandle } from "./context-scope-model";

const facts: ContextScopeFacts = {
    loaded: true,
    contextOf: { w1: "work", w2: "work", w3: "book" },
    dirContext: { "/src/forge": "work", "/src/novel": "book" },
};

function item(key: string, over: Partial<ToHandleItem> = {}): ToHandleItem {
    return { key, ...over } as ToHandleItem;
}

function info(key: string, workspaceid: string): InfoItem {
    return { key, workspaceid } as InfoItem;
}

function agent(blockid: string, workspaceid: string): AgentStateInfo {
    return { blockid, workspaceid, state: "working", version: 1 } as AgentStateInfo;
}

describe("which rows are the window's context's (FR-BOSS-009)", () => {
    it("keeps the rows of the workspaces of the context", () => {
        expect(rowInContext(facts, "work", { workspaceid: "w1" })).toBe(true);
        expect(rowInContext(facts, "work", { workspaceid: "w3" })).toBe(false);
        expect(rowInContext(facts, "book", { workspaceid: "w3" })).toBe(true);
    });

    it("places a pull request's row by its project folder, a trailing slash aside", () => {
        expect(rowInContext(facts, "work", { dir: "/src/forge" })).toBe(true);
        expect(rowInContext(facts, "work", { dir: "/src/forge/" })).toBe(true);
        expect(rowInContext(facts, "work", { dir: "/src/novel" })).toBe(false);
    });

    it("prefers the workspace to the folder when a row names both", () => {
        expect(rowInContext(facts, "work", { workspaceid: "w1", dir: "/src/novel" })).toBe(true);
    });

    it("keeps what names no workspace and no folder, and what names one nobody knows yet", () => {
        expect(rowInContext(facts, "work", {})).toBe(true);
        expect(rowInContext(facts, "work", { workspaceid: "new" })).toBe(true);
        expect(rowInContext(facts, "work", { dir: "/elsewhere" })).toBe(true);
    });

    it("hides nothing before the window knows where the workspaces are", () => {
        expect(rowInContext(EmptyScopeFacts, "work", { workspaceid: "w3" })).toBe(true);
        expect(rowInContext(facts, "", { workspaceid: "w3" })).toBe(true);
    });
});

describe("the rows To handle of a window", () => {
    const list: ToHandleList = {
        items: [item("a", { workspaceid: "w1" }), item("b", { workspaceid: "w3" }), item("pr", { dir: "/src/novel" }), item("app")],
        info: [info("done1", "w1"), info("done3", "w3")],
        parked: 2,
        parkedKeys: ["x"],
    };

    it("lists the context's rows, the finished agents of its workspaces and the app's rows", () => {
        const scoped = scopeToHandle(list, facts, "work");
        expect(scoped.items.map((i) => i.key)).toEqual(["a", "app"]);
        expect(scoped.info.map((i) => i.key)).toEqual(["done1"]);
        expect(scoped.parked).toBe(2);
        expect(scopeToHandle(list, facts, "book").items.map((i) => i.key)).toEqual(["b", "pr", "app"]);
    });

    it("gives the list back as it is when nothing is left out, so nothing reads it again", () => {
        const all: ToHandleList = { items: [item("a", { workspaceid: "w1" })], info: [], parked: 0 };
        expect(scopeToHandle(all, facts, "work")).toBe(all);
        expect(scopeToHandle(list, EmptyScopeFacts, "work")).toBe(list);
    });
});

describe("the agents behind a window's visits, badge and counts", () => {
    const data: AgentStatesData = {
        states: { b1: agent("b1", "w1"), b2: agent("b2", "w3"), b3: agent("b3", "") },
        versions: { b1: 1, b2: 1, b3: 1 },
    };

    it("keeps the agents of the context's workspaces, and one with no workspace", () => {
        const scoped = scopeAgents(data, facts, "work");
        expect(Object.keys(scoped.states).sort()).toEqual(["b1", "b3"]);
        expect(scoped.versions).toBe(data.versions);
    });

    it("gives the data back as it is when no agent is left out", () => {
        expect(scopeAgents(data, facts, "book")).not.toBe(data);
        const alone: AgentStatesData = { states: { b1: agent("b1", "w1") }, versions: { b1: 1 } };
        expect(scopeAgents(alone, facts, "work")).toBe(alone);
        expect(scopeAgents(data, EmptyScopeFacts, "work")).toBe(data);
    });
});
