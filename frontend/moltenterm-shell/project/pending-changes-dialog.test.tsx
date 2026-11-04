// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../dialog-frame", () => ({ DialogFrame: ({ children }: { children: React.ReactNode }) => children }));

import type { Milestone } from "../mission/github";
import type { MissionGit } from "../mission/mission-model";
import { nextStation, waitingCounts } from "./next-station-model";
import { PendingChangesDialog } from "./pending-changes-dialog";

const Oct13 = new Date("2026-10-13T09:00:00Z").getTime();

// Chores only since v1.1.0 on develop, and nothing ahead of main: the Waiting dialog has no change to group.
const Git = {
    trunk: "develop",
    release: "main",
    branches: [],
    tags: [{ name: "v1.1.0", sha: "t1", date: "2026-09-20T10:00:00Z" }],
    lastpublic: "v1.1.0",
    ahead: [],
    sincepublic: [{ sha: "c0", date: "2026-10-01T10:00:00Z", subject: "chore: bump dependencies" }],
    tagprefix: "v",
    remoteurl: "",
} as MissionGit;

const Milestone1_1_1: Milestone = {
    number: 13,
    title: "v1.1.1",
    open_issues: 27,
    closed_issues: 3,
    due_on: "2026-10-16T07:00:00Z",
    html_url: "https://github.com/o/r/milestone/13",
};

function dialog(planned: ReturnType<typeof nextStation>) {
    return renderToStaticMarkup(
        <PendingChangesDialog
            dir="/p"
            git={Git}
            tag={planned?.tag ?? null}
            counts={waitingCounts(Git)}
            planned={planned}
            onClose={() => {}}
        />
    );
}

describe("the Waiting dialog of a planned station (#1751)", () => {
    it("says the version is planned, with its milestone's open count and due date, instead of an empty list", () => {
        const planned = nextStation(Git, null, [Milestone1_1_1], Oct13);
        expect(planned.state).toBe("planned");
        const html = dialog(planned);
        expect(html).toContain('data-testid="pending-changes-planned"');
        expect(html).toContain("Planned — milestone v1.1.1, 27 open, nothing on develop yet");
        expect(html).toContain("Due Oct 16 (milestone v1.1.1)");
        expect(html).not.toContain("pending-changes-empty");
    });

    it("says the planned version has no due date when its milestone has none", () => {
        const planned = nextStation(Git, null, [{ ...Milestone1_1_1, due_on: undefined }], Oct13);
        const html = dialog(planned);
        expect(html).toContain("Planned — milestone v1.1.1, 27 open, nothing on develop yet");
        expect(html).not.toContain("Due ");
    });

    it("keeps the empty message for a release the commits justify but nothing waits for", () => {
        const html = dialog(null);
        expect(html).not.toContain("pending-changes-planned");
        expect(html).toContain('data-testid="pending-changes-empty"');
    });
});
