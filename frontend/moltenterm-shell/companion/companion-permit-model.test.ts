// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { KeepAwakeApproval, KeepAwakeState } from "../keepawake-model";
import type { CompanionView } from "./companion-model";
import {
    agentSessionId,
    answerable,
    applyPermitState,
    autonomousApprovals,
    autonomyEnded,
    autonomyLeftMs,
    autonomyOf,
    countdownText,
    EmptyPermitState,
    folderName,
    liveSessionId,
    modeOf,
    periodOf,
    PermitAutonomy,
    permitKind,
    PermitRequest,
    PermitState,
    requestOfBlock,
    requestText,
    sentence,
} from "./companion-permit-model";

const Session = "11111111-2222-3333-4444-555555555555";
const Minute = 60_000;

function request(over: Partial<PermitRequest> = {}): PermitRequest {
    return { id: "r1", blockid: "b1", tool: "Bash", toolinput: { command: "ls" }, at: 1000, state: "held", ...over };
}

function autonomy(over: Partial<PermitAutonomy> = {}): PermitAutonomy {
    return { blockid: "b1", sessionid: Session, mode: "always", since: 1000, approved: 0, ...over };
}

describe("the gate's state", () => {
    it("takes the newer state and keeps the older one out", () => {
        const first: PermitState = { version: 3, requests: [request()], autonomy: [] };
        expect(applyPermitState(EmptyPermitState, first)).toEqual(first);
        expect(applyPermitState(first, { version: 2, requests: [], autonomy: [] })).toBe(first);
        expect(applyPermitState(first, null)).toBe(first);
        expect(applyPermitState(first, { version: 3, requests: [], autonomy: [] }).requests).toEqual([]);
    });

    it("reads a state with no lists as empty ones", () => {
        const applied = applyPermitState(EmptyPermitState, { version: 1 } as PermitState);
        expect(applied.requests).toEqual([]);
        expect(applied.autonomy).toEqual([]);
    });
});

describe("the agent session", () => {
    it("names a Claude Code session by its transcript and a Codex one by the id its rollout ends with", () => {
        expect(agentSessionId(`/home/me/.claude/projects/x/${Session}.jsonl`)).toBe(Session);
        expect(agentSessionId(`C:\\Users\\me\\.claude\\projects\\x\\${Session}.jsonl`)).toBe(Session);
        expect(agentSessionId(`/home/me/.codex/sessions/2026/11/23/rollout-2026-11-23T10-00-00-${Session}.jsonl`)).toBe(
            Session
        );
        expect(agentSessionId("/s/other-session.jsonl")).toBe("other-session");
        expect(agentSessionId("")).toBe("");
        expect(agentSessionId(null)).toBe("");
    });

    it("follows the session the agent runs now, not the earlier one the companion shows", () => {
        const other = "99999999-8888-7777-6666-555555555555";
        const view = (session: CompanionView["session"]) =>
            ({ blockid: "b1", version: 1, status: "live", session }) as CompanionView;
        expect(liveSessionId(view({ path: `/s/${Session}.jsonl`, linkedby: "hook" }))).toBe(Session);
        expect(
            liveSessionId(
                view({ path: `/s/${other}.jsonl`, linkedby: "picked", earlier: true, livepath: `/s/${Session}.jsonl` })
            )
        ).toBe(Session);
        expect(liveSessionId(view({ path: `/s/${other}.jsonl`, linkedby: "picked", earlier: true }))).toBe(other);
        expect(liveSessionId(view(undefined))).toBe("");
        expect(liveSessionId(null)).toBe("");
    });
});

describe("the request of a terminal", () => {
    it("is the newest one of that terminal", () => {
        const state: PermitState = {
            version: 1,
            requests: [
                request({ id: "old", at: 1 }),
                request({ id: "new", at: 5 }),
                request({ id: "other", blockid: "b2", at: 9 }),
            ],
            autonomy: [],
        };
        expect(requestOfBlock(state, "b1").id).toBe("new");
        expect(requestOfBlock(state, "b2").id).toBe("other");
        expect(requestOfBlock(state, "b3")).toBeNull();
        expect(requestOfBlock(EmptyPermitState, "b1")).toBeNull();
    });

    it("can be answered while it is held and has time left", () => {
        expect(answerable(request({ deadline: 5000 }), 4000)).toBe(true);
        expect(answerable(request({ deadline: 5000 }), 5000)).toBe(false);
        expect(answerable(request({ state: "terminal", reason: "force push" }), 0)).toBe(false);
        expect(answerable(null, 0)).toBe(false);
    });

    it("counts down to the terminal as minutes and seconds, never below zero", () => {
        expect(countdownText(112_000, 0)).toBe("1:52");
        expect(countdownText(120_000, 0)).toBe("2:00");
        expect(countdownText(5_400, 0)).toBe("0:06");
        expect(countdownText(1_000, 5_000)).toBe("0:00");
    });
});

describe("what the block shows of a request", () => {
    it("shows a command as typed and anything else as the tool's input", () => {
        expect(requestText(request({ toolinput: { command: "go test ./...", description: "Run the tests" } }))).toBe(
            "go test ./..."
        );
        expect(requestText(request({ tool: "shell", toolinput: { command: ["git", "status"] } }))).toBe("git status");
        expect(requestText(request({ tool: "Edit", toolinput: { file_path: "/w/a.ts", new_string: "x" } }))).toBe(
            JSON.stringify({ file_path: "/w/a.ts", new_string: "x" }, null, 2)
        );
        expect(requestText(request({ toolinput: { command: [1, 2] } }))).toBe(
            JSON.stringify({ command: [1, 2] }, null, 2)
        );
        expect(requestText(request({ toolinput: undefined }))).toBe("");
        expect(requestText(null)).toBe("");
    });

    it("sorts the tools into what the sentence says", () => {
        expect(permitKind("Bash")).toBe("command");
        expect(permitKind("exec_command")).toBe("command");
        expect(permitKind("Write")).toBe("edit");
        expect(permitKind("apply_patch")).toBe("edit");
        expect(permitKind("Grep")).toBe("read");
        expect(permitKind("WebFetch")).toBe("web");
        expect(permitKind("mcp__server__do")).toBe("tool");
    });

    it("names the project by the last folder, and a sentence starts with a capital", () => {
        expect(folderName("/Users/me/work/app")).toBe("app");
        expect(folderName("/Users/me/work/app/")).toBe("app");
        expect(folderName("C:\\work\\app")).toBe("app");
        expect(folderName("")).toBe("");
        expect(sentence("force push of a main branch: main")).toBe("Force push of a main branch: main");
        expect(sentence("")).toBe("");
    });
});

describe("the session's autonomous mode", () => {
    const state = (a: PermitAutonomy[]): PermitState => ({ version: 1, requests: [], autonomy: a });

    it("is found by terminal and session id, whatever the id's case", () => {
        const s = state([autonomy()]);
        expect(autonomyOf(s, "b1", Session, 0)).not.toBeNull();
        expect(autonomyOf(s, "b1", Session.toUpperCase(), 0)).not.toBeNull();
        expect(autonomyOf(s, "b2", Session, 0)).toBeNull();
        expect(autonomyOf(s, "b1", "11111111-2222-3333-4444-666666666666", 0)).toBeNull();
        expect(autonomyOf(s, "b1", "", 0)).toBeNull();
        expect(autonomyOf(s, "", Session, 0)).toBeNull();
        expect(autonomyOf(EmptyPermitState, "b1", Session, 0)).toBeNull();
    });

    it("asks again once its period ended, before wavesrv says so", () => {
        const period = autonomy({ mode: "for", since: 0, until: 15 * Minute });
        expect(autonomyEnded(period, 15 * Minute - 1)).toBe(false);
        expect(autonomyEnded(period, 15 * Minute)).toBe(true);
        expect(autonomyEnded(autonomy(), Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(autonomyOf(state([period]), "b1", Session, 15 * Minute)).toBeNull();
        expect(autonomyOf(state([period]), "b1", Session, 14 * Minute)).not.toBeNull();
    });

    it("says the mode, the time left and the period chosen", () => {
        expect(modeOf(null)).toBe("ask");
        expect(modeOf(autonomy())).toBe("always");
        const hour = autonomy({ mode: "for", since: 10 * Minute, until: 70 * Minute });
        expect(modeOf(hour)).toBe("for");
        expect(autonomyLeftMs(hour, 18 * Minute)).toBe(52 * Minute);
        expect(autonomyLeftMs(hour, 80 * Minute)).toBe(0);
        expect(autonomyLeftMs(autonomy(), 0)).toBeNull();
        expect(autonomyLeftMs(null, 0)).toBeNull();
        expect(periodOf(hour)).toBe("1h");
        expect(periodOf(autonomy({ mode: "for", since: 0, until: 15 * Minute }))).toBe("15m");
        expect(periodOf(autonomy({ mode: "for", since: 0, until: 240 * Minute }))).toBe("4h");
        expect(periodOf(autonomy({ mode: "for", since: 0, until: 7 * 60 * Minute }))).toBe("tonight");
        expect(periodOf(autonomy())).toBeNull();
        expect(periodOf(null)).toBeNull();
    });

    it("lists the approvals of that session since the mode began, the coffee's own left out", () => {
        const approval = (over: Partial<KeepAwakeApproval>): KeepAwakeApproval => ({
            id: "p",
            at: 2000,
            blockid: "b1",
            sessionid: Session,
            tool: "Bash",
            outcome: "approved",
            source: "autonomous",
            ...over,
        });
        const keep = {
            approvals: [
                approval({ id: "p1" }),
                approval({ id: "p2", sessionid: Session.toUpperCase() }),
                approval({ id: "before", at: 999 }),
                approval({ id: "coffee", source: undefined }),
                approval({ id: "other-terminal", blockid: "b2" }),
                approval({ id: "other-session", sessionid: "11111111-2222-3333-4444-666666666666" }),
            ],
        } as KeepAwakeState;
        expect(autonomousApprovals(keep, autonomy()).map((a) => a.id)).toEqual(["p1", "p2"]);
        expect(autonomousApprovals(keep, null)).toEqual([]);
        expect(autonomousApprovals(null, autonomy())).toEqual([]);
    });
});
