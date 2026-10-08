// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", () => ({ getApi: () => ({ switchWorkspace: () => {} }) }));
vi.mock("../mission/group-sync", () => ({ syncDependency: async () => ({ ok: true }) }));

import { ProjectGroup } from "../mission/group-model";
import { stripMembers } from "../mission/group-strip-model";
import { GroupStrip, GroupStripView } from "./group-strip";
import { ProjectCardProps } from "./project-context";

const NOW = Date.now();

const group: ProjectGroup = {
    key: "notulia",
    name: "Notulia",
    members: [
        {
            dir: "/r/Notulia",
            name: "Notulia",
            group: "Notulia",
            workspaces: [{ id: "w-app" }],
            state: {
                collectedat: NOW,
                trunkci: "success",
                remoteci: "success",
                lasttag: "v1.0.0",
                releasetag: "v1.0.0",
            },
        },
        {
            dir: "/r/site",
            name: "notulia-website",
            group: "notulia",
            workspaces: [{ id: "w-site", name: "Site" }],
            state: {
                collectedat: NOW,
                deps: [
                    {
                        index: 0,
                        project: "Notulia",
                        paths: ["features/*.json"],
                        output: ["src/features.json"],
                        sync: "node scripts/sync-features.mjs",
                        branch: "develop",
                        state: "stale",
                        changed: ["features/live-notes.json"],
                        commits: [{ sha: "7f51307", time: NOW, subject: "feat(#1151): Pro", tickets: ["1151"] }],
                    },
                ],
            },
        },
    ],
};

function render(workspaceId: string, dir: string): string {
    return renderToStaticMarkup(
        <GroupStripView
            name={group.name}
            members={stripMembers(group, workspaceId, dir, NOW)}
            syncs={{}}
            onSwitch={() => {}}
            onSync={() => {}}
        />
    );
}

describe("group strip view", () => {
    it("draws every member, the linked one marked and the other one a switch", () => {
        const html = render("w-app", "/r/Notulia");
        expect(html.match(/data-testid="group-strip-member"/g)).toHaveLength(2);
        expect(html).toContain('aria-current="true"');
        expect(html.match(/data-testid="group-strip-current"/g)).toHaveLength(1);
        expect(html.match(/data-testid="group-strip-switch"/g)).toHaveLength(1);
        expect(html).toContain("Switch to its workspace (Site)");
    });

    it("shows the stale flag with its commit, ticket and Sync, and no other action", () => {
        const html = render("w-app", "/r/Notulia");
        expect(html).toContain("Behind Notulia on develop");
        expect(html).toContain("features/live-notes.json");
        expect(html).toContain("1151");
        expect(html.match(/data-testid="group-strip-sync"/g)).toHaveLength(1);
        for (const action of ["Run CI", "Build local", "Release…", "Clean branches"]) {
            expect(html).not.toContain(action);
        }
    });

    it("draws nothing for a project in no product", () => {
        const props = { project: { workspace: { oid: "w-solo" }, dir: "/r/solo" }, group: null } as ProjectCardProps;
        expect(renderToStaticMarkup(<GroupStrip {...props} />)).toBe("");
        expect(render("w-solo", "/r/solo")).toBe("");
    });
});
