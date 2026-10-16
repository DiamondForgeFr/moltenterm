// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    integrationSetting,
    integrationSettingText,
    integrationVia,
    turnOffForAgent,
    turnOffForEveryAgent,
    turnOnForAgent,
} from "./companion-integration-model";
import { CompanionView, integrationProblem, isIntegrated, statusMessage } from "./companion-model";

const added = [
    { kind: "statehooks", name: "Agent state hooks (Stop)" },
    { kind: "sessionlink", name: "Session link" },
];

function view(integration: CompanionView["integration"], status: CompanionView["status"] = "loading"): CompanionView {
    return { blockid: "b1", version: 1, status, agentname: "Claude Code", integration } as CompanionView;
}

describe("the integration of a run (FR-SHELL-040)", () => {
    it("is shown for a run that got additions, not for one that stepped aside", () => {
        expect(isIntegrated(view({ agent: "claude", realpath: "/c", added }))).toBe(true);
        expect(isIntegrated(view({ agent: "claude", realpath: "/c", stepaside: "started by a running agent" }))).toBe(
            false
        );
        expect(isIntegrated(view({ agent: "claude", realpath: "/c", added: [] }))).toBe(false);
        expect(isIntegrated(view(null))).toBe(false);
    });

    it("does not call the user's own choice a problem", () => {
        const off = view({
            agent: "claude",
            realpath: "/c",
            stepaside: "the integration is turned off in MoltenTerm's settings (agent:integrate)",
        });
        expect(integrationProblem(off)).toBeNull();
        const slow = view({
            agent: "claude",
            realpath: "/c",
            stepaside: "MoltenTerm's settings could not be read in time",
        });
        expect(integrationProblem(slow)).toContain("could not be read in time");
    });

    it("asks no integrated session to paste a hook (AC6)", () => {
        const integrated = statusMessage(view({ agent: "claude", realpath: "/c", added }, "searching"));
        expect(integrated.detail).not.toContain("hook");
        expect(integrated.detail).toContain("integration links it");
        const plain = statusMessage(view(null, "searching"));
        expect(plain.detail).toBe("It shows as soon as the agent writes its first message.");
        expect(plain.detail).not.toMatch(/hook|SessionStart|molten docs/);
    });

    it("reads and writes the settings per agent or for every agent", () => {
        expect(integrationSetting({}, "claude")).toBe("on");
        expect(integrationSetting({ "agent:integrateoff": ["codex"] }, "claude")).toBe("on");
        expect(integrationSetting({ "agent:integrateoff": ["codex"] }, "codex")).toBe("agentoff");
        expect(integrationSetting({ "agent:integrate": false, "agent:integrateoff": ["codex"] }, "codex")).toBe(
            "alloff"
        );
        expect(turnOffForAgent({ "agent:integrateoff": ["codex"] }, "claude")).toEqual({
            "agent:integrateoff": ["codex", "claude"],
        });
        expect(turnOffForAgent({ "agent:integrateoff": ["claude"] }, "claude")).toEqual({
            "agent:integrateoff": ["claude"],
        });
        expect(turnOffForEveryAgent()).toEqual({ "agent:integrate": false });
        expect(turnOnForAgent({ "agent:integrateoff": ["claude"] }, "claude")).toEqual({
            "agent:integrate": null,
            "agent:integrateoff": null,
        });
        expect(turnOnForAgent({ "agent:integrateoff": ["claude", "codex"] }, "claude")).toEqual({
            "agent:integrate": null,
            "agent:integrateoff": ["codex"],
        });
        expect(integrationSettingText("on", "Codex")).toBeNull();
        expect(integrationSettingText("agentoff", "Codex")).toContain("Turned off for Codex from the next launch");
    });

    it("says how the additions reach the agent", () => {
        expect(
            integrationVia({ agent: "claude", realpath: "/c", settings: "/d/a.json", mcpconfig: "/d/m.json" })
        ).toEqual(["--settings /d/a.json", "--mcp-config /d/m.json"]);
        expect(integrationVia({ agent: "codex", realpath: "/c", args: ["-c", "notify=[1]", "--x"] })).toEqual([
            "-c notify=[1]",
            "--x",
        ]);
    });
});
