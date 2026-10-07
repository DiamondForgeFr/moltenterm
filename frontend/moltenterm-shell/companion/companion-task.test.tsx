// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceTaskCard, WorkspaceTaskCardProps } from "./companion-task";
import {
    authorLabel,
    filesCount,
    firstLine,
    newerTask,
    planCounts,
    redactionLabel,
    taskSummary,
    TaskView,
} from "./companion-task-model";

vi.mock("@/app/store/global", () => ({ createBlockSplitHorizontally: vi.fn() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn() } }));
vi.mock("@/app/store/tab-model", () => ({ getActiveTabModel: () => null }));
vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: () => null }));

const now = Date.UTC(2026, 9, 7, 10, 5, 0);

// What wavesrv returns for a workspace after a Claude Code turn (pkg/molten/agentcontinuity/checkpoint).
const view: TaskView = {
    workspaceid: "ws-1",
    path: "/data/molten/tasks/ws-1/checkpoint.md",
    exists: true,
    updated: now - 3 * 60 * 1000,
    updatedby: "auto",
    transcript: { agent: "claude", session: "s1", path: "/home/me/.claude/projects/x/s1.jsonl" },
    redactions: 2,
    versions: 3,
    sections: [
        { name: "Goal", owner: "auto", text: "Plan the login page in three steps. Use [redacted]" },
        { name: "Ticket", owner: "auto", text: "#42, on branch `feature/42-login`." },
        {
            name: "Plan and progress",
            owner: "auto",
            text: "1 of 3 done.\n\n- [x] Write the form\n- [ ] Test it (in progress)\n- [ ] Document it",
        },
        { name: "Decisions", text: "" },
        { name: "Files touched", owner: "auto", text: "- `src/login.go` (modified)\n- `src/login_test.go` (added)" },
        { name: "Open questions", text: "" },
        { name: "Next steps", owner: "user", text: "- Run the e2e suite" },
        { name: "Last transcript", owner: "auto", text: "- Agent: Claude Code" },
    ],
};

function card(props: Partial<WorkspaceTaskCardProps>): string {
    const noop = () => {};
    return renderToStaticMarkup(
        <WorkspaceTaskCard
            view={view}
            now={now}
            confirming={false}
            actionError={null}
            onOpen={noop}
            onEdit={noop}
            onAskClear={noop}
            onCancelClear={noop}
            onClear={noop}
            {...props}
        />
    );
}

describe("workspace task model", () => {
    it("summarises the checkpoint", () => {
        const s = taskSummary(view);
        expect(s.empty).toBe(false);
        expect(s.goal).toBe("Plan the login page in three steps. Use [redacted]");
        expect(s.ticket).toBe("#42, on branch `feature/42-login`.");
        expect(s.plan).toEqual({ done: 1, total: 3 });
        expect(s.files).toBe(2);
        expect(s.next).toBe("Run the e2e suite");
        expect(s.by).toBe("MoltenTerm, from Claude Code");
        expect(s.redactions).toBe(2);
        expect(s.versions).toBe(3);
    });

    it("names who wrote it", () => {
        expect(authorLabel("user")).toBe("you");
        expect(authorLabel("auto")).toBe("MoltenTerm");
        expect(authorLabel("auto", { agent: "codex" })).toBe("MoltenTerm, from Codex");
        expect(authorLabel("codex:0199")).toBe("Codex");
        expect(authorLabel("")).toBe("");
    });

    it("reads Markdown lists", () => {
        expect(firstLine("\n- [x] done\n- other")).toBe("done");
        expect(firstLine("* item")).toBe("item");
        expect(firstLine("")).toBe("");
        expect(planCounts("- [X] a\n- [ ] b\n  - [x] c\nnot a task")).toEqual({ done: 2, total: 3 });
        expect(filesCount("- `a`\n- `b`\n\ntext")).toBe(2);
        expect(redactionLabel(0)).toBe("");
        expect(redactionLabel(1)).toBe("1 secret redacted");
        expect(redactionLabel(4)).toBe("4 secrets redacted");
    });

    it("treats a missing or blank checkpoint as empty", () => {
        expect(taskSummary({ ...view, exists: false }).empty).toBe(true);
        expect(taskSummary({ ...view, sections: view.sections.map((s) => ({ ...s, text: " " })) }).empty).toBe(true);
    });

    it("keeps the newest read", () => {
        const older = { ...view, updated: 1 };
        expect(newerTask(view, older)).toBe(view);
        expect(newerTask(older, view)).toBe(view);
        expect(newerTask(view, null)).toBe(view);
        const other = { ...view, workspaceid: "ws-2", updated: 0 };
        expect(newerTask(view, other)).toBe(other);
    });
});

describe("workspace task section", () => {
    it("shows the last update, its author, the redactions and the actions", () => {
        const html = card({});
        expect(html).toContain("Workspace task");
        expect(html).toContain("updated 3 min ago");
        expect(html).toContain("Plan the login page");
        expect(html).toContain("Plan 1 / 3");
        expect(html).toContain("2 files");
        expect(html).toContain("Next: </span>Run the e2e suite");
        expect(html).toContain("by MoltenTerm, from Claude Code");
        expect(html).toContain("2 secrets redacted");
        expect(html).toContain("3 earlier versions");
        expect(html).toContain(">Open<");
        expect(html).toContain(">Edit<");
        expect(html).toContain("Clear…");
        expect(html).not.toContain("Start a new task");
    });

    it("asks before clearing", () => {
        const html = card({ confirming: true });
        expect(html).toContain("Start a new task?");
        expect(html).toContain("stays in the history");
        expect(html).toContain("molten-btn-destructive");
        expect(html).not.toContain("Clear…");
    });

    it("explains an empty task and offers only Edit", () => {
        const html = card({ view: { ...view, exists: false, sections: [], updated: 0, redactions: 0, versions: 0 } });
        expect(html).toContain("No task recorded yet");
        expect(html).toContain(">Edit<");
        expect(html).not.toContain(">Open<");
        expect(html).not.toContain("Clear…");
        expect(html).not.toContain("updated");
    });

    it("shows an action's error", () => {
        expect(card({ actionError: "the block's workspace was not found" })).toContain(
            "the block&#x27;s workspace was not found"
        );
    });
});
