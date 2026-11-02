// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view stays a view whatever it holds (#1246): the temporary list shows every temporary view, those where an agent
// runs included, and no longer counts views "under their agents".

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { TemporaryViews } from "./workspace-sidebar";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

describe("the temporary list with agents (#1246)", () => {
    // Which views the list gets is sidebarSections' rule (sidebar-agents-model.test.ts); the list has no header (#1253)
    // and counts no view.
    it("shows no counter of views under agents", () => {
        const html = renderToStaticMarkup(
            <TemporaryViews ids={[]} activeTabId={null} asideRef={createRef<HTMLElement>()} />
        );
        expect(html).toContain("sidebar-temporary");
        expect(html).not.toContain("sidebar-temporary-under-agents");
        expect(html).not.toMatch(/under (its|their) agents?/);
    });

    it("ships no text for the removed counter", () => {
        expect((en as any).sidebar.temporary.underAgents).toBeUndefined();
        expect((fr as any).sidebar.temporary.underAgents).toBeUndefined();
    });
});
