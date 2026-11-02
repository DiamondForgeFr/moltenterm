// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { backend } = vi.hoisted(() => ({
    backend: {
        closable: true,
        workspace: { oid: "ws-1", name: "Mine", tabids: ["t1", "t2"] } as any,
        tabs: [{ blockids: ["b1", "b2"] }, { blockids: ["b3"] }] as any[],
    },
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom(null), uiContext: atom({ windowid: "win-1" }), staticTabId: atom("t1") },
        getApi: () => ({ deleteWorkspace: () => {}, resetWorkspace: () => {}, undoWorkspace: () => {} }),
    };
});
vi.mock("@/app/store/services", () => ({
    WorkspaceService: {
        GetWorkspace: async () => backend.workspace,
        CanCloseWorkspace: async () => backend.closable,
        PendingWorkspaceUndo: async (): Promise<any> => null,
    },
    ObjectService: { GetObjects: async () => backend.tabs },
}));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getObjectValue: (): any => null,
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("./busy-close-store", () => ({
    busyCloseEnabled: () => false,
    readWorkspaceRunning: async (): Promise<any[]> => [],
}));
vi.mock("./busy-close", () => ({ RunningList: (): any => null }));
// The real frame portals into document.body; what the dialog says is checked here.
vi.mock("./dialog-frame", () => ({
    DialogFrame: ({ role, title, subtitle, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role}>
            <div data-subtitle="">{subtitle}</div>
            {children}
            {buttons}
        </div>
    ),
}));

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { I18nModel } from "./i18n/i18n";
import { askDeleteWorkspace, askResetWorkspace, WorkspaceResetHost } from "./workspace-reset";
import { workspaceUndoToast } from "./workspace-reset-model";

async function dialogFor(ask: (id: string) => Promise<void>): Promise<string> {
    await ask("ws-1");
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <WorkspaceResetHost />
        </Provider>
    );
}

afterEach(async () => {
    backend.closable = true;
    I18nModel.getInstance().setLanguageSetting("en");
    await I18nModel.getInstance().whenReady();
});

describe("the reset and delete dialog (FR-SHELL-095)", () => {
    it("says it is the only workspace only for the last one", async () => {
        backend.closable = true;
        expect(await dialogFor(askResetWorkspace)).not.toContain("only workspace");
        backend.closable = false;
        expect(await dialogFor(askResetWorkspace)).toContain("It is your only workspace");
    });

    it("asks to delete in the same dialog, naming what is lost and that undo restarts nothing", async () => {
        const html = await dialogFor(askDeleteWorkspace);
        expect(html).toContain('data-role="workspace-delete"');
        expect(html).toContain("Delete the workspace &quot;Mine&quot;?");
        expect(html).toContain("Its 2 views and their 3 panels will close; terminals and agents stop.");
        expect(html).toContain("what was stopped does not restart");
        expect(html).toContain("Delete workspace");
        expect(html).not.toContain("starts again with one new view");
    });

    it("has a calm destructive button without the molten wave (#1318)", async () => {
        const html = await dialogFor(askDeleteWorkspace);
        expect(html).not.toContain("molten-btn");
        expect(html).not.toContain("molten-wave");
        expect(html).toMatch(/<button[^>]*class="[^"]*border-error[^"]*"[^>]*data-action="delete"/);
    });

    it("asks to reset the last workspace when a stale menu still offers Delete", async () => {
        backend.closable = false;
        const html = await dialogFor(askDeleteWorkspace);
        expect(html).toContain('data-role="workspace-reset"');
    });

    it("speaks French", async () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        await I18nModel.getInstance().whenReady();
        const html = await dialogFor(askDeleteWorkspace);
        expect(html).toContain("Supprimer l&#x27;espace de travail « Mine » ?");
        expect(html).toContain(
            "Ses 2 vues et leurs 3 panneaux seront fermés ; les terminaux et les agents s&#x27;arrêtent."
        );
    });
});

describe("the undo toast", () => {
    it("offers Undo for the time left, named after the action", () => {
        const offer = { undoid: "u", kind: "delete", workspaceid: "ws-1", name: "Mine", remainingms: 8000 };
        const toast = workspaceUndoToast(offer, () => {});
        expect(toast.title).toBe('Workspace "Mine" deleted');
        expect(toast.dismissMs).toBe(8000);
        expect(toast.actions.map((a) => a.label)).toEqual(["Undo"]);
        expect(workspaceUndoToast({ ...offer, kind: "reset" }, () => {}).title).toBe('Workspace "Mine" reset');
    });
});
