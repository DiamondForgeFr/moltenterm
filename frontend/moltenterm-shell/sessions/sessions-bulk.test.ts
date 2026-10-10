// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { AgentInputResult } from "../command-panel/agent-commands";
import {
    BulkCommands,
    bulkConfirmText,
    bulkItems,
    BulkRunners,
    bulkSkip,
    bulkSummary,
    busyNote,
    checkState,
    pruneSelected,
    rangeSelected,
    restartResult,
    runBulk,
    sendResult,
    toggleAll,
    toggleSelected,
} from "./sessions-bulk";
import { agentCell, atPrompt, DurableSession, lastActive, runningCommand, sessionName } from "./sessions-model";

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
        blockid: `block-${id}`,
        ...extra,
    };
}

const claude = (id: string, extra: Partial<DurableSession> = {}) =>
    session(id, { agent: "claude", agentname: "Claude Code", agentstate: "idle", command: "claude", ...extra });
const codex = (id: string, extra: Partial<DurableSession> = {}) =>
    session(id, { agent: "codex", agentname: "Codex", agentstate: "idle", command: "codex", ...extra });

function fakeRunners(): BulkRunners & { calls: any[] } {
    const calls: any[] = [];
    return {
        calls,
        end: vi.fn(async (s) => {
            calls.push(["end", s.id]);
            return {};
        }),
        restart: vi.fn(async (req) => {
            calls.push(["restart", req]);
            if (req.blockid === "block-busy") {
                return {
                    status: "agentbusy",
                    message: "Claude Code is working: update the terminal once its turn ends.",
                };
            }
            return { status: "restarted", message: "Restarted. Claude Code resumes its session (claude --resume x)." };
        }),
        send: vi.fn(async (req): Promise<AgentInputResult> => {
            calls.push(["send", req]);
            if (req.blockid === "block-busy") {
                return { result: "refused", reason: "working", message: "Claude Code is working." };
            }
            return { result: "sent", message: `Sent ${req.action}.` };
        }),
    };
}

describe("sessions table columns", () => {
    it("names a row by its tab, else its folder, never by the shell at its prompt", () => {
        const shell = session("a", { command: "zsh at prompt", folder: "/Users/me/src/moltenterm", tabname: "T1" });
        expect(atPrompt(shell)).toBe(true);
        expect(sessionName(shell, Home)).toBe("moltenterm");
        expect(agentCell(shell)).toEqual({ label: "Shell", kind: "shell" });
        expect(sessionName({ ...shell, tabname: "API server" }, Home)).toBe("API server");
        expect(sessionName({ ...shell, folder: Home }, Home)).toBe("Home");
        expect(sessionName({ ...shell, folder: undefined }, Home)).toBe("Terminal");
    });

    it("shows a running command and an agent in the agent column", () => {
        const dev = session("a", { command: "npm run dev", folder: "/w/app" });
        expect(runningCommand(dev)).toBe("npm run dev");
        expect(agentCell(dev)).toEqual({ label: "npm run dev", kind: "command" });
        expect(agentCell(claude("b"))).toEqual({ label: "Claude Code", kind: "agent" });
        expect(runningCommand(claude("b"))).toBe("");
    });

    it("tells when a session was last active", () => {
        const now = 1_000_000;
        expect(lastActive(session("a", { lastoutputat: now - 120_000 }), now)).toBe("2 min ago");
        expect(lastActive(session("a", { startedat: now - 1000 }), now)).toBe("now");
        expect(lastActive(session("a"), now)).toBe("");
    });
});

describe("selection", () => {
    const order = ["a", "b", "c", "d", "e"];

    it("toggles and selects ranges across groups in table order", () => {
        let sel = toggleSelected(new Set(), "b");
        expect([...sel]).toEqual(["b"]);
        sel = rangeSelected(sel, order, "b", "d");
        expect([...sel].sort()).toEqual(["b", "c", "d"]);
        // The range takes the anchor's state.
        sel = rangeSelected(toggleSelected(sel, "b"), order, "b", "c");
        expect([...sel]).toEqual(["d"]);
    });

    it("selects all, a group, and clears", () => {
        expect(checkState(new Set(), order)).toBe("none");
        expect(checkState(new Set(["a"]), order)).toBe("some");
        const all = toggleAll(new Set(["a"]), order);
        expect(checkState(all, order)).toBe("all");
        expect(checkState(toggleAll(all, order), order)).toBe("none");
        expect([...toggleAll(new Set(["e"]), ["a", "b"])].sort()).toEqual(["a", "b", "e"]);
    });

    it("drops sessions that are gone", () => {
        const sel = new Set(["a", "x"]);
        expect([...pruneSelected(sel, order)]).toEqual(["a"]);
        const kept = new Set(["a"]);
        expect(pruneSelected(kept, order)).toBe(kept);
    });
});

describe("bulk eligibility", () => {
    it("leaves out what an agent action cannot reach", () => {
        expect(bulkSkip("restart", claude("a"))).toBe("");
        expect(bulkSkip("restart", session("a", { command: "zsh at prompt" }))).toBe("Not a coding agent");
        expect(bulkSkip("restart", claude("a", { connection: "user@host" }))).toMatch(/only local agents/);
        expect(bulkSkip("restart", claude("a", { shown: false }))).toMatch(/Not in a pane/);
        expect(bulkSkip("end", session("a", { canend: false }))).toBe("Cannot be ended now");
        expect(bulkSkip("end", session("a"))).toBe("");
    });

    it("maps one command to each agent's table", () => {
        const fresh = BulkCommands.find((c) => c.label === "New conversation");
        expect(fresh.actions.claude.action).toBe("clear");
        expect(fresh.actions.codex.action).toBe("new");
        const review = BulkCommands.find((c) => c.label === "Review");
        expect(bulkSkip("send", codex("a"), review)).toBe("Codex has no Review command");
        expect(BulkCommands.some((c) => c.id === "quit" || c.id === "model")).toBe(false);
    });

    it("warns about a busy agent before the run", () => {
        expect(busyNote("restart", claude("a", { agentstate: "working" }))).toMatch(/working now/);
        expect(busyNote("restart", claude("a", { agentstate: "waiting" }))).toMatch(/waiting for you/);
        const interrupt = BulkCommands.find((c) => c.id === "interrupt");
        expect(busyNote("send", claude("a", { agentstate: "working" }), interrupt)).toBe("");
        expect(busyNote("end", claude("a", { agentstate: "working" }))).toBe("");
    });

    it("counts the sessions the confirmation reaches", () => {
        const items = bulkItems("restart", [claude("a"), codex("b"), session("c")]);
        const text = bulkConfirmText("restart", items);
        expect(text.title).toBe("Restart 2 agents with the current settings?");
        expect(text.subtitle).toMatch(/1 selected session is left out/);
        expect(bulkConfirmText("end", bulkItems("end", [session("a")])).confirm).toBe("End 1 session");
    });
});

describe("bulk run", () => {
    it("restarts three sessions in two workspaces, skips a busy one and the ones it cannot reach", async () => {
        const list = [
            claude("a", { workspaceid: "ws1" }),
            codex("b", { workspaceid: "ws2" }),
            claude("busy", { workspaceid: "ws2" }),
            session("plain"),
        ];
        const runners = fakeRunners();
        const seen: string[] = [];
        const results = await runBulk(
            "restart",
            bulkItems("restart", list),
            runners,
            { mode: "bypassPermissions" },
            (r) => seen.push(r.id)
        );
        expect(seen).toEqual(["a", "b", "busy", "plain"]);
        expect(results.map((r) => r.kind)).toEqual(["done", "done", "skipped", "skipped"]);
        // Only Claude Code gets the mode; Codex keeps its own settings and says so.
        expect(runners.calls).toEqual([
            ["restart", { blockid: "block-a", agent: "claude", mode: "bypassPermissions" }],
            ["restart", { blockid: "block-b", agent: "codex", mode: undefined }],
            ["restart", { blockid: "block-busy", agent: "claude", mode: "bypassPermissions" }],
        ]);
        expect(results[1].message).toMatch(/Codex kept its own permission settings/);
        expect(results[3].message).toBe("Not a coding agent");
        expect(bulkSummary("restart", results)).toEqual({
            title: "Restarted 2 of 4 sessions",
            detail: "2 skipped",
            tone: "skipped",
        });
    });

    it("sends one command once to each agent, with the draft consent of the confirmation", async () => {
        const runners = fakeRunners();
        const fresh = BulkCommands.find((c) => c.label === "New conversation");
        const results = await runBulk(
            "send",
            bulkItems("send", [claude("a"), codex("b")], fresh),
            runners,
            { command: fresh },
            () => {}
        );
        expect(results.map((r) => r.kind)).toEqual(["done", "done"]);
        expect(runners.calls).toEqual([
            ["send", { blockid: "block-a", agent: "claude", action: "clear", confirmeddraft: true }],
            ["send", { blockid: "block-b", agent: "codex", action: "new", confirmeddraft: true }],
        ]);
    });

    it("ends exactly the selected sessions and reports a failure with its reason", async () => {
        const runners = fakeRunners();
        runners.end = vi.fn(async (s: DurableSession) => {
            if (s.id === "b") {
                throw new Error("session not found");
            }
            return s.id === "c" ? { pending: true } : {};
        });
        const results = await runBulk(
            "end",
            bulkItems("end", [session("a"), session("b"), session("c")]),
            runners,
            {},
            () => {}
        );
        expect(runners.end).toHaveBeenCalledTimes(3);
        expect(results).toEqual([
            { id: "a", kind: "done", message: "Ended." },
            { id: "b", kind: "failed", message: "session not found" },
            { id: "c", kind: "done", message: "Ends once its host is back." },
        ]);
    });

    it("reads wavesrv's answers", () => {
        expect(restartResult("a", null).kind).toBe("failed");
        expect(restartResult("a", { status: "agentstuck", message: "did not exit" }).kind).toBe("failed");
        expect(restartResult("a", { status: "busy", message: "vim" }).kind).toBe("skipped");
        expect(sendResult("a", { result: "refused", reason: "waiting", message: "waiting" }).kind).toBe("skipped");
        expect(sendResult("a", { result: "refused", reason: "notforeground", message: "vim" }).kind).toBe("failed");
        expect(sendResult("a", null).kind).toBe("failed");
    });
});
