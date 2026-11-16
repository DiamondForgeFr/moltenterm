// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-CONT-014 (#2324): what an agent's Connections offer on its first name, how a lock names its project, and which
// locks a project's sheet lists.

import { describe, expect, it } from "vitest";
import {
    asksToMove,
    lockFailureText,
    lockProjectLabel,
    locksOfProject,
    nameAction,
    sameProjectFolder,
    unlockFailureText,
} from "./agent-name-locks-model";
import type { AgentStateInfo } from "./agent-state-model";

function info(fields: Partial<AgentStateInfo>): AgentStateInfo {
    return { blockid: "b1", agent: "claude", agentname: "Claude Code", version: 1, ...fields };
}

describe("the first name an agent's Connections offer to lock (FR-CONT-014)", () => {
    it("offers Lock for the agent's project while the name is free", () => {
        expect(nameAction(info({ firstname: "Flore", project: "/projects/alpha" }))).toEqual({
            kind: "lock",
            name: "Flore",
            project: "/projects/alpha",
            lockedFor: "",
        });
    });

    it("offers Unlock once the name is locked for the agent's project", () => {
        expect(
            nameAction(info({ firstname: "Flore", project: "/projects/alpha", namelockedfor: "/projects/alpha/" }))
        ).toEqual({ kind: "unlock", name: "Flore", project: "/projects/alpha/" });
    });

    it("offers Lock again, with the project that holds the name, when it is locked for another one", () => {
        expect(
            nameAction(info({ firstname: "Flore", project: "/projects/alpha", namelockedfor: "/projects/beta" }))
        ).toEqual({ kind: "lock", name: "Flore", project: "/projects/alpha", lockedFor: "/projects/beta" });
    });

    it("offers Unlock for a locked name whose agent is in no project, and nothing for a free one", () => {
        expect(nameAction(info({ firstname: "Flore", namelockedfor: "/projects/beta" })).kind).toBe("unlock");
        expect(nameAction(info({ firstname: "Flore" })).kind).toBe("none");
    });

    it("offers nothing without an agent or a first name", () => {
        expect(nameAction(null).kind).toBe("none");
        expect(nameAction(info({ project: "/projects/alpha" })).kind).toBe("none");
    });

    it("asks before taking a name from another project, and only then", () => {
        const free = nameAction(info({ firstname: "Flore", project: "/projects/alpha" }));
        const elsewhere = nameAction(
            info({ firstname: "Flore", project: "/projects/alpha", namelockedfor: "/projects/beta" })
        );
        const mine = nameAction(
            info({ firstname: "Flore", project: "/projects/alpha", namelockedfor: "/projects/alpha" })
        );
        expect(asksToMove(free)).toBe(false);
        expect(asksToMove(elsewhere)).toBe(true);
        expect(asksToMove(mine)).toBe(false);
        expect(asksToMove(nameAction(null))).toBe(false);
    });
});

describe("naming a locked name's project", () => {
    const projects = [
        { id: "p1", type: "Website", dir: "/clients/acme", branch: "", repo: "/clients/acme/site" },
        { id: "p2", type: "", dir: "/projects/beta", branch: "" },
    ];

    it("names the workspace's project by its label, whether its folder or its repository is the key", () => {
        expect(lockProjectLabel("/clients/acme/site", projects)).toBe("Website");
        expect(lockProjectLabel("/clients/acme/", projects)).toBe("Website");
        expect(lockProjectLabel("/projects/beta/", projects)).toBe("beta");
    });

    it("names any other project by its folder", () => {
        expect(lockProjectLabel("/elsewhere/gamma", projects)).toBe("gamma");
        expect(lockProjectLabel("/elsewhere/gamma", [])).toBe("gamma");
    });

    it("compares folders without a closing slash or the direction of the separators", () => {
        expect(sameProjectFolder("/projects/alpha/", "/projects/alpha")).toBe(true);
        expect(sameProjectFolder("C:\\work\\alpha", "C:/work/alpha")).toBe(true);
        expect(sameProjectFolder("/projects/alpha", "/projects/alpha-site")).toBe(false);
        expect(sameProjectFolder("", "")).toBe(false);
    });

    it("keeps a project's locks in the order they were made", () => {
        const locks = [
            { name: "Rose", project: "/projects/beta" },
            { name: "Flore", project: "/projects/alpha" },
            { name: "Léa", project: "/projects/alpha/" },
        ];
        expect(locksOfProject(locks, "/projects/alpha").map((l) => l.name)).toEqual(["Flore", "Léa"]);
        expect(locksOfProject(locks, "/projects/none")).toEqual([]);
        expect(locksOfProject(null, "/projects/alpha")).toEqual([]);
    });
});

describe("what a lock that did not happen says", () => {
    it("says nothing when the name is locked, or when the move is still to be asked", () => {
        for (const status of ["locked", "already", "elsewhere"] as const) {
            expect(lockFailureText({ status }, "Flore")).toBe("");
        }
        expect(unlockFailureText({ status: "unlocked" }, "Flore")).toBe("");
        expect(unlockFailureText({ status: "none" }, "Flore")).toBe("");
    });

    it("words each refusal", () => {
        expect(lockFailureText({ status: "noagent" }, "Flore")).toBe("No agent holds a first name in this terminal.");
        expect(lockFailureText({ status: "noproject" }, "Flore")).toBe(
            "This terminal is in no project folder, so Flore has no project to be locked for."
        );
        expect(lockFailureText({ status: "notlockable" }, "Flore 2")).toContain("Flore 2 is a numbered name");
        expect(lockFailureText({ status: "failed" }, "Flore")).toBe(
            "The lock could not be saved in MoltenTerm's data: nothing changed."
        );
        expect(unlockFailureText({ status: "failed" }, "Flore")).toBe(
            "The change could not be saved in MoltenTerm's data: Flore stays locked."
        );
    });
});
