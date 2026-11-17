// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The lock on a locked first name in an agent's panel header (FR-CONT-014, #2324): after the title, with the project in
// its tooltip; a free name shows none.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MoltenHeaderLead, type MoltenHeaderState } from "./panel-header";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

function state(fields: Partial<MoltenHeaderState>): MoltenHeaderState {
    return {
        blockId: "blk-1",
        title: "Flore · Claude Code",
        titleHint: "",
        agentTitle: true,
        lockedFor: "",
        lockedName: "",
        local: true,
        remoteConnection: "",
        remoteTitle: "",
        context: [],
        model: "",
        modelTitle: "",
        modelUnavailable: false,
        effort: "",
        effortTitle: "",
        pill: null,
        working: false,
        termHeader: false,
        preview: false,
        openConnection: () => {},
        ...fields,
    };
}

function render(s: MoltenHeaderState) {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <MoltenHeaderLead
                state={s}
                iconElem={<i />}
                iconName="terminal"
                iconColor=""
                manageConnection={false}
                localHostName=""
                connBtnRef={{ current: null }}
                preIcon={null}
            />
        </Provider>
    );
}

describe("the lock in an agent's header (#2324)", () => {
    it("follows the title of an agent whose name is locked, naming the project in its tooltip", () => {
        const html = render(state({ lockedFor: "/projects/alpha", lockedName: "Flore" }));
        expect(html).toMatch(
            /data-testid="agent-header-label"[^>]*>Flore · Claude Code<i [^>]*title="Flore is locked for alpha: a new agent there gets it back\."/
        );
    });

    it("shows no lock on a free name", () => {
        const html = render(state({}));
        expect(html).toContain("Flore · Claude Code");
        expect(html).not.toContain('data-testid="agent-name-lock"');
    });
});
