// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { current } = vi.hoisted(() => ({ current: { ws: null as Workspace } }));

vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    useWaveObjectValue: () => [current.ws, false],
}));
vi.mock("@/app/store/global", () => ({ atoms: {}, getApi: () => ({}) }));
vi.mock("@/app/store/services", () => ({ WorkspaceService: {} }));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://localhost" }));
vi.mock("./workspace-edit", () => ({
    WorkspaceEditModel: { getInstance: () => ({}) },
    listenWorkspaceMenu: () => {},
    pickUpWorkspaceEdit: () => false,
}));
vi.mock("./workspace-reset", () => ({ askResetWorkspace: () => {} }));
vi.mock("./workspace-project-section", () => ({
    WorkspaceProjectBlock: () => <div data-stub="project">Link a project…</div>,
    WorkspaceFolderLine: () => <div data-stub="folder">Change…</div>,
}));
// The real frame portals into document.body; the sheet's content is what is checked here.
vi.mock("./dialog-frame", () => ({
    useEscape: () => {},
    DialogFrame: ({ role, title, subtitle, widthClass, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role} data-width={widthClass}>
            <div data-subtitle="1">{subtitle}</div>
            {children}
            {buttons}
        </div>
    ),
}));

import { ColourChoices, IconChoices, WorkspaceEditSheet } from "./workspace-edit-sheet";

const ws = { oid: "w1", name: "Client A", icon: "rocket", color: "#429DFF", meta: {} } as any as Workspace;

function sheet(closable: boolean) {
    current.ws = ws;
    return renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable={closable} onClose={() => {}} />);
}

describe("workspace edit sheet (FR-SHELL-030-AC5…AC8)", () => {
    it("is one MoltenTerm dialog named Edit workspace, with the workspace's name under its title", () => {
        const html = sheet(true);
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-label="Edit workspace"');
        expect(html).toContain('data-role="workspace-edit"');
        expect(html).toContain('<div data-subtitle="1">Client A</div>');
        expect(html).toContain('data-width="w-[560px]"');
        expect(html).not.toContain("workspace-editor");
    });

    it("lays out Identity, Project, Folder and Danger zone in that order, each with a heading", () => {
        const html = sheet(true);
        const headings = [...html.matchAll(/<h3 id="[^"]+"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
        expect(headings).toEqual(["Identity", "Project", "Folder", "Danger zone"]);
        expect([...html.matchAll(/<section aria-labelledby="([^"]+)"/g)]).toHaveLength(4);
        expect(html.indexOf('data-stub="project"')).toBeLessThan(html.indexOf('data-stub="folder"'));
    });

    it("holds a labelled name field and a preview of the rail badge at its real size", () => {
        const html = sheet(true);
        expect(html).toMatch(/<label for="([^"]+)"[^>]*>Name<\/label><input id="\1"/);
        expect(html).toContain('value="Client A"');
        expect(html).toContain('aria-invalid="false"');
        expect(html).toMatch(/data-role="rail-preview" class="[^"]*\bh-9 w-9\b[^"]*text-\[17px\]/);
        expect(html).toContain('aria-label="Rail badge: Rocket, Blue"');
    });

    it("offers Delete, or Reset with #222's reason on the last workspace", () => {
        expect(sheet(true)).toMatch(/data-action="delete"[^>]*>Delete workspace</);
        const last = sheet(false);
        expect(last).toMatch(/data-action="reset"[^>]*>Reset workspace…</);
        expect(last).toContain("The only workspace: reset it instead.");
        expect(last).not.toContain("Delete workspace");
    });

    it("closes with Done, a molten call to action", () => {
        expect(sheet(true)).toMatch(/<button type="button" class="molten-btn cursor-pointer[^"]*">Done/);
    });

    it("shows nothing until the workspace is known", () => {
        current.ws = null;
        expect(renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable onClose={() => {}} />)).toBe("");
    });
});

describe("icon and colour choices are named radio groups (NFR-SHELL-014)", () => {
    it("names each icon, marks the chosen one and gives it the only tab stop", () => {
        const html = renderToStaticMarkup(
            <IconChoices icons={["rocket", "star", "mug-hot"]} selected="star" color="#429DFF" onSelect={() => {}} />
        );
        expect(html).toMatch(/<div id="([^"]+)"[^>]*>Icon<\/div><div role="radiogroup" aria-labelledby="\1"/);
        const radios = [
            ...html.matchAll(/role="radio" aria-checked="(true|false)" aria-label="([^"]+)"[^>]*tabindex="(-?\d)"/g),
        ];
        expect(radios.map((m) => [m[2], m[1], m[3]])).toEqual([
            ["Rocket", "false", "-1"],
            ["Star", "true", "0"],
            ["Hot mug", "false", "-1"],
        ]);
        expect(html).toContain("cursor-pointer");
        expect(html).toContain("h-8 w-8");
        expect(html).toContain("flex-wrap");
    });

    it("names each colour and marks the chosen one with a check, not by colour alone", () => {
        const html = renderToStaticMarkup(
            <ColourChoices colors={["#FF7C0D", "#429DFF"]} selected="#429DFF" onSelect={() => {}} />
        );
        expect(html).toContain('role="radiogroup"');
        expect(html).toMatch(/aria-checked="false" aria-label="Orange"/);
        expect(html).toMatch(/aria-checked="true" aria-label="Blue"/);
        expect(html.match(/fa-check/g)).toHaveLength(1);
        expect(html).toContain("h-7 w-7");
    });

    it("keeps a tab stop on the first option when none is chosen", () => {
        const html = renderToStaticMarkup(
            <ColourChoices colors={["#FF7C0D", "#429DFF"]} selected="" onSelect={() => {}} />
        );
        expect([...html.matchAll(/tabindex="(-?\d)"/g)].map((m) => m[1])).toEqual(["0", "-1"]);
    });
});
