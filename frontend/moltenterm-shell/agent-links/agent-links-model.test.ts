// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    addServerHint,
    agentLinkRows,
    agentTitle,
    BlockLinks,
    headerBadge,
    linkActions,
    LinkInfo,
    needsAgentStep,
    openRequestFor,
    readLinksGestureArgs,
    repairHint,
    showLinksIcon,
    siteEntries,
    versionNoteKey,
    waitingHandoffs,
} from "./agent-links-model";

function link(over: Partial<LinkInfo>): LinkInfo {
    return { key: "molten-browser:1", server: "molten-browser", state: "connected", controllable: true, ...over };
}

function block(links: LinkInfo[], second: LinkInfo[] = []): BlockLinks {
    return {
        blockid: "b1",
        version: "1.0.0",
        agents: [
            { main: true, agent: "claude", agentname: "Claude Code", firstname: "Valentin", model: "Opus", links },
            ...(second.length
                ? [{ agent: "codex", agentname: "Codex", clientname: "codex-mcp-client", links: second }]
                : []),
        ],
    };
}

describe("agent links model", () => {
    it("badges a broken link, and a waiting request first", () => {
        expect(headerBadge(block([link({})]), 0)).toBeNull();
        expect(headerBadge(block([link({})], [link({ key: "k2", state: "broken", controllable: false })]), 0)).toBe(
            "broken"
        );
        expect(headerBadge(block([link({ state: "reconnecting" })]), 0)).toBe("broken");
        expect(headerBadge(block([link({ outdated: true, updatepending: true })]), 0)).toBeNull();
        expect(headerBadge(block([link({ outdated: true, updateblocked: "writable" })]), 0)).toBe("broken");
        expect(headerBadge(block([link({ state: "stopped" })]), 0)).toBeNull();
        expect(headerBadge(block([link({ state: "broken" })]), 1)).toBe("waiting");
    });

    it("shows the icon with an agent or a link only", () => {
        expect(showLinksIcon(false, null)).toBe(false);
        expect(showLinksIcon(true, null)).toBe(true);
        expect(showLinksIcon(false, { blockid: "b1", version: "", agents: [{ links: [] }] })).toBe(false);
        expect(showLinksIcon(false, block([link({})]))).toBe(true);
    });

    it("counts the open handoff requests of the asking pane", () => {
        const entries = [
            { key: "agenthandoff:1", blockid: "b1" },
            { key: "agenthandoff:2", blockid: "b1", resolved: 5 },
            { key: "agenthandoff:3", blockid: "b2" },
            { key: "agentlink:b1", blockid: "b1" },
        ];
        expect(waitingHandoffs(entries, "b1")).toBe(1);
    });

    it("adds a not started row when the agent has no molten-browser", () => {
        const rows = agentLinkRows({ links: [link({ server: "molten-review", key: "molten-review:3" })] });
        expect(rows.map((r) => (r.notStarted ? "notstarted" : r.link.server))).toEqual(["notstarted", "molten-review"]);
        expect(agentLinkRows({ links: [link({})] }).some((r) => r.notStarted)).toBe(false);
    });

    it("offers Reconnect and Stop only where MoltenTerm reaches the server", () => {
        expect(linkActions(link({}))).toEqual(["reconnect", "stop"]);
        expect(linkActions(link({ state: "stopped" }))).toEqual(["reconnect"]);
        expect(linkActions(link({ state: "broken", controllable: false }))).toEqual([]);
        expect(linkActions(link({ state: "legacy", controllable: false }))).toEqual([]);
        expect(needsAgentStep({ link: link({ state: "broken", controllable: false }) })).toBe(true);
        expect(needsAgentStep({ link: link({}) })).toBe(false);
        expect(needsAgentStep({ link: link({ state: "stopped", controllable: false }) })).toBe(true);
    });

    it("words the agent's own step per agent, with a generic fallback", () => {
        expect(repairHint("claude", true)).toEqual({ key: "agentLinks.hint.claude", typeMcp: true });
        // /mcp is typed only into the terminal's detected agent: another agent in the pane is not its foreground.
        expect(repairHint("claude", false).typeMcp).toBe(false);
        expect(repairHint("codex", true).typeMcp).toBeUndefined();
        expect(repairHint("gemini", true).key).toBe("agentLinks.hint.generic");
        expect(addServerHint("opencode").command).toBe("molten mcp browser");
    });

    it("names the version note", () => {
        expect(versionNoteKey(link({}))).toBeNull();
        expect(versionNoteKey(link({ outdated: true, updatepending: true }))).toBe("agentLinks.version.pending");
        expect(versionNoteKey(link({ outdated: true, updateblocked: "x" }))).toBe("agentLinks.version.blocked");
        expect(versionNoteKey(link({ outdated: true }))).toBe("agentLinks.version.older");
    });

    it("titles agents, an undetected one by its MCP client", () => {
        expect(agentTitle(block([]).agents[0])).toBe("Valentin · Claude Code · Opus");
        expect(agentTitle({ clientname: "my-agent", links: [] })).toBe("my-agent");
    });

    it("lists stored site decisions only", () => {
        expect(siteEntries({ "b.com": "allow", "a.com": "block", "c.com": "weird" })).toEqual([
            { site: "a.com", decision: "block" },
            { site: "b.com", decision: "allow" },
        ]);
    });

    it("reads the notice's place and keeps an open request for a while", () => {
        expect(readLinksGestureArgs({})).toBeNull();
        expect(readLinksGestureArgs({ blockid: "b1", tabid: "", workspaceid: "w" })).toEqual({
            blockid: "b1",
            tabid: undefined,
            workspaceid: "w",
        });
        expect(openRequestFor({ blockid: "b1", at: 1000 }, "b1", 2000)).toBe(true);
        expect(openRequestFor({ blockid: "b1", at: 1000 }, "b2", 2000)).toBe(false);
        expect(openRequestFor({ blockid: "b1", at: 1000 }, "b1", 100000)).toBe(false);
    });
});
