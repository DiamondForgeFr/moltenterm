// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../dialog-frame", () => ({
    DialogFrame: ({ title, subtitle, children, buttons }: any) => (
        <div role="dialog" aria-label={title}>
            <div>{subtitle}</div>
            {children}
            {buttons}
        </div>
    ),
}));

import { LogWatchPickDialog } from "./logwatch-pick";

// FR-BOSS-012 AC9: the pick lists the agents of MoltenTerm's repository in wavesrv's order (wavesrv offers no other
// project's), the first one selected, and says where the excerpt goes.
describe("the pick of who looks", () => {
    it("lists the agents in wavesrv's order, the first selected", () => {
        const html = renderToStaticMarkup(
            <LogWatchPickDialog
                agents={[
                    {
                        blockid: "b1",
                        firstname: "Olivia",
                        agentname: "Claude Code",
                        workspace: "MoltenTerm",
                        project: "moltenterm",
                    },
                    {
                        blockid: "b2",
                        firstname: "Paul",
                        agentname: "Codex",
                        workspace: "MoltenTerm",
                        project: "moltenterm",
                    },
                ]}
                onAnswer={vi.fn()}
            />
        );
        const rows = html.split('data-testid="logwatch-pick-agent"').slice(1);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain("Olivia");
        expect(rows[1]).toContain("Paul");
        expect(html).toMatch(/aria-checked="true"[^>]*data-agent="b1"/);
        expect(html).toMatch(/aria-checked="false"[^>]*data-agent="b2"/);
        expect(rows[0]).toContain("Claude Code · MoltenTerm · moltenterm");
        expect(html).toContain("only to that agent and to its model provider");
        expect(html).toContain('data-testid="logwatch-pick-send"');
        expect(html).toContain("molten-btn");
    });
});
