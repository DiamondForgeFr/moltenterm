// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Who, what, from where, and whether it runs the current version (FR-SHELL-058, #933).

import { describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import {
    activityTitle,
    canInterrupt,
    canUpdate,
    contextLinks,
    DurableSession,
    endConfirmText,
    flattenGroups,
    groupSessions,
    modelText,
    placeColumn,
    rowName,
    sessionKind,
    sessionKindLabel,
    startedFrom,
    updateAllConfirmText,
    updateConfirmText,
    versionMark,
} from "./sessions-model";

const Home = "/Users/me";

function session(id: string, extra: Partial<DurableSession> = {}): DurableSession {
    return {
        id,
        shortid: id.slice(0, 8),
        connection: "",
        connstate: "connected",
        workspaceorder: 0,
        shown: true,
        canshow: true,
        canend: true,
        workspaceid: "ws1",
        workspacename: "Work",
        tabname: "Main",
        blockid: `block-${id}`,
        ...extra,
    };
}

describe("identity", () => {
    it("leads with the agent's first name, else the place", () => {
        expect(rowName(session("a", { agent: "claude", firstname: "Valentin" }), Home)).toBe("Valentin");
        expect(rowName(session("b", { tabname: "API server" }), Home)).toBe("API server");
    });

    it("tells a direct session from an agent MoltenTerm started", () => {
        const direct = session("d", { agent: "claude" });
        const ci = session("c", { agent: "claude", origin: { kind: "investigate", repo: "acme/app", number: 891 } });
        expect(sessionKind(direct)).toBe("direct");
        expect(sessionKindLabel(direct)).toBe("Direct");
        expect(sessionKind(ci)).toBe("started");
        expect(sessionKindLabel(ci)).toBe("Analyze and resolve");
        expect(sessionKind(session("x", { origin: { kind: "unknown" as any } }))).toBe("direct");
    });

    it("says where it was started", () => {
        expect(startedFrom(session("d"))).toBe("Work › Main");
        expect(startedFrom(session("r", { origin: { kind: "review", number: 3 } }))).toBe("Review panel");
        expect(startedFrom(session("b", { origin: { kind: "batch" } }))).toBe("Merge queue");
        expect(startedFrom(session("i", { origin: { kind: "investigate", number: 1 } }))).toBe("Integration");
        expect(startedFrom(session("h", { shown: false }))).toBe("not in a pane");
    });

    it("shows the model and effort only when the agent reported them", () => {
        expect(modelText(session("a", { agent: "claude", modelname: "Opus 5.5", effort: "high" }))).toBe(
            "Opus 5.5 · effort high"
        );
        expect(modelText(session("b", { agent: "codex", model: "gpt-5" }))).toBe("gpt-5");
        expect(modelText(session("c", { agent: "claude" }))).toBe("");
        expect(modelText(session("d", { modelname: "Opus" }))).toBe("");
    });

    it("names the session by its first name when ending it", () => {
        const s = session("a", { agent: "claude", agentname: "Claude Code", firstname: "Valentin" });
        expect(endConfirmText(s, Home, 0).title).toBe("End Valentin (Claude Code)?");
    });
});

describe("context", () => {
    it("links the ticket and the PR with its state", () => {
        const s = session("a", {
            context: { repo: "acme/app", ticket: 890, pr: 891, prstate: "merged", prtitle: "Fix the dialog" },
        });
        const links = contextLinks(s);
        expect(links.map((l) => l.label)).toEqual(["#890", "PR #891"]);
        expect(links[0].url).toBe("https://github.com/acme/app/issues/890");
        expect(links[1].url).toBe("https://github.com/acme/app/pull/891");
        expect(links[1].state).toBe("merged");
        expect(links[1].title).toBe("Fix the dialog · merged");
    });

    it("keeps a PR without a known state, and no link without a repository", () => {
        const links = contextLinks(session("a", { context: { pr: 5 } }));
        expect(links).toHaveLength(1);
        expect(links[0].url).toBeUndefined();
        expect(links[0].state).toBeUndefined();
        expect(contextLinks(session("b"))).toEqual([]);
    });

    it("shows the worktree's branch in full, its path to copy", () => {
        const wt = session("a", {
            folder: "/Users/me/app-wt/src",
            worktree: { path: "/Users/me/app-wt", branch: "feature/933-sessions-view-metadata" },
        });
        expect(placeColumn(wt, Home)).toMatchObject({
            label: "feature/933-sessions-view-metadata",
            copy: "/Users/me/app-wt",
        });
        expect(placeColumn(session("b", { folder: "/Users/me/code" }), Home)).toMatchObject({
            label: "~/code",
            copy: "/Users/me/code",
        });
    });
});

describe("state", () => {
    it("says when it started and for how long it runs", () => {
        const start = new Date(2026, 9, 20, 9, 5).getTime();
        const now = start + 90 * 60 * 1000;
        const title = activityTitle(session("a", { startedat: start }), now, "en-GB");
        expect(title).toContain("Started 09:05");
        expect(title).toContain("Running for 1 h 30 min");
    });

    it("offers Interrupt only to a working local agent in a pane", () => {
        expect(canInterrupt(session("a", { agent: "claude", agentstate: "working" }))).toBe(true);
        expect(canInterrupt(session("b", { agent: "claude", agentstate: "idle" }))).toBe(false);
        expect(canInterrupt(session("c", { agent: "claude", agentstate: "working", connection: "box" }))).toBe(false);
        expect(canInterrupt(session("d", { agent: "claude", agentstate: "working", shown: false }))).toBe(false);
        expect(canInterrupt(session("e", { agentstate: "working" }))).toBe(false);
    });
});

describe("sub-sessions", () => {
    it("nests a sub-session under its parent, in the parent's group", () => {
        const list = [
            session("lead", { startedat: 1 }),
            session("helper", { startedat: 2, parentid: "lead", workspaceid: "ws2", workspacename: "Other" }),
            session("grand", { startedat: 3, parentid: "helper" }),
            session("solo", { startedat: 4 }),
        ];
        const groups = groupSessions(list, "ws1");
        expect(groups.map((g) => g.id)).toEqual(["ws1"]);
        expect(flattenGroups(groups)).toEqual(["solo", "lead", "helper", "grand"]);
        expect(groups[0].depths).toEqual({ helper: 1, grand: 2 });
    });

    it("keeps a session whose parent is not listed at the top", () => {
        const groups = groupSessions(
            [session("a", { parentid: "gone" }), session("self", { parentid: "self" })],
            "ws1"
        );
        expect(flattenGroups(groups).sort()).toEqual(["a", "self"]);
        expect(groups[0].depths).toBeUndefined();
    });
});

describe("up to date", () => {
    const outdated = new Set(["block-old"]);

    it("marks outdated sessions and the ones an older version started", () => {
        expect(versionMark(session("old"), outdated)).toBe("outdated");
        expect(versionMark(session("new"), outdated)).toBeNull();
        expect(versionMark(session("x", { reason: "olderversion" }), outdated)).toBe("older");
        expect(versionMark(session("old", { connection: "box" }), outdated)).toBeNull();
    });

    it("updates only an outdated session in a pane", () => {
        expect(canUpdate(session("old"), outdated)).toBe(true);
        expect(canUpdate(session("old", { shown: false }), outdated)).toBe(false);
        expect(canUpdate(session("new"), outdated)).toBe(false);
    });

    it("confirms with the session's name and warns about a working agent", () => {
        const s = session("old", {
            agent: "claude",
            agentname: "Claude Code",
            firstname: "Léa",
            agentstate: "working",
        });
        const text = updateConfirmText(s, Home);
        expect(text.title).toBe("Update Léa?");
        expect(text.subtitle).toContain("resuming its conversation");
        expect(text.warning).toContain("is working");
        expect(updateConfirmText(session("shell"), Home).warning).toBeUndefined();
        expect(updateAllConfirmText([session("a"), session("b")]).confirm).toBe("Update 2 sessions");
    });

    it("words the same in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(sessionKindLabel(session("d"))).toBe("Directe");
            expect(updateAllConfirmText([session("a")]).title).toBe("Mettre à jour 1 session ?");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });
});
