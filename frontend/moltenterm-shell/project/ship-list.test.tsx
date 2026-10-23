// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../open-web-link", () => ({ openWebLink: async () => {} }));

import type { MergedHistoryPr } from "../reviews/merged-history-model";
import { ShipListView } from "./ship-list";
import { shipGroups } from "./ship-list-model";

describe("ShipListView", () => {
    it("shows behaviour changes first under their heading, nested tickets and the commits without a ticket", () => {
        const prs = [
            {
                number: 5,
                title: "fix(#2): menu",
                url: "https://github.com/acme/app/pull/5",
                branch: "fix/2-menu",
                base: "develop",
                mergedat: "2026-10-20T12:00:00Z",
                ticket: 2,
                ships: "next",
                tickettitle: "Menu closes",
                tickettype: "Task",
                summary: "Escape closes the menu.",
                behaviour: { from: "section", verify: "Escape with an unsaved draft" },
                ticketparents: [{ number: 9, title: "Menus epic", type: "Epic" }],
            } as MergedHistoryPr,
        ];
        const groups = shipGroups(
            [
                { sha: "a".repeat(40), subject: "feat(#1): cards", date: "2026-10-21T00:00:00Z" },
                { sha: "b".repeat(40), subject: "fix(#2): menu", date: "2026-10-20T00:00:00Z" },
                { sha: "c".repeat(40), subject: "chore: bump", date: "2026-10-19T00:00:00Z" },
            ],
            prs,
            (n) => `https://github.com/acme/app/issues/${n}`
        );
        const html = renderToStaticMarkup(<ShipListView groups={groups} />);
        expect(html).toContain("Changes behaviour you know");
        expect(html.indexOf("Menus epic")).toBeLessThan(html.indexOf("cards"));
        expect(html).toContain("Escape closes the menu.");
        expect(html).toContain("To verify: Escape with an unsaved draft");
        expect(html).toContain("Without a ticket");
        expect(html).toContain(">feature<");
        expect(html).toContain(">fix<");
    });
});
