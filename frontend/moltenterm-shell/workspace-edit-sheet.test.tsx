// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { current } = vi.hoisted(() => ({ current: { ws: null as Workspace } }));

vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    useWaveObjectValue: () => [current.ws, false],
}));
vi.mock("@/app/store/global", () => ({ atoms: {}, getApi: () => ({ getDataDir: () => "/data" }) }));
vi.mock("@/app/store/services", () => ({ WorkspaceService: {} }));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://localhost" }));
vi.mock("./workspace-edit", () => ({
    WorkspaceEditModel: { getInstance: () => ({}) },
    listenWorkspaceMenu: () => {},
    pickUpWorkspaceEdit: () => false,
}));
vi.mock("./workspace-reset", () => ({ askResetWorkspace: () => {} }));
vi.mock("./workspace-project-store", () => ({
    chooseMoltentermPath: async () => null,
    findProjectLogos: async () => [],
    setWorkspaceLogo: async () => {},
}));
vi.mock("./workspace-project-section", () => ({
    WorkspaceProjectBlock: () => <div data-stub="project">Link a project…</div>,
    WorkspaceFolderLine: () => <div data-stub="folder">Change…</div>,
}));
// The real frame portals into document.body; the sheet's content is what is checked here.
vi.mock("./dialog-frame", () => ({
    useEscape: () => {},
    DialogFrame: ({ role, title, subtitle, subtitleClass, widthClass, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role} data-width={widthClass}>
            <div data-subtitle={subtitleClass}>{subtitle}</div>
            {children}
            {buttons}
        </div>
    ),
}));

import { ColourChoices, IconChoices, ImagePane, initialIconMode, WorkspaceEditSheet } from "./workspace-edit-sheet";

const ws = { oid: "w1", name: "Client A", icon: "rocket", color: "#429DFF", meta: {} } as any as Workspace;

function sheet(closable: boolean) {
    current.ws = ws;
    return renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable={closable} onClose={() => {}} />);
}

describe("workspace edit sheet (FR-SHELL-030-AC5…AC8)", () => {
    it("is one MoltenTerm dialog titled Workspace, with its folder in mono 11 under the title (DS-SHELL-101)", () => {
        const html = sheet(true);
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-label="Workspace"');
        expect(html).toContain('data-role="workspace-edit"');
        expect(html).toContain('<div data-subtitle="font-mono text-11"></div>');
        current.ws = { ...ws, meta: { "molten:folder": "/Users/me/code/client-a" } } as any as Workspace;
        expect(renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable onClose={() => {}} />)).toContain(
            '<div data-subtitle="font-mono text-11">/Users/me/code/client-a</div>'
        );
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
        expect(html).toMatch(/data-role="rail-preview" class="[^"]*\bh-9 w-9\b[^"]*text-icon-16/);
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

describe("one Icon field, Symbol or Image (FR-SHELL-059-AC1, FR-SHELL-031)", () => {
    const Stored = "w1-0123456789ab.png";

    function sheetWith(meta: Record<string, any>) {
        current.ws = { ...ws, meta } as any as Workspace;
        return renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable onClose={() => {}} />);
    }

    function pane(meta: Record<string, any>, logos: string[]) {
        return renderToStaticMarkup(
            <ImagePane
                ws={{ ...ws, meta } as any as Workspace}
                logos={logos}
                over={false}
                busy={false}
                result={null}
                dropHandlers={{}}
                onPick={() => {}}
                onLogo={() => {}}
            />
        );
    }

    it("shows a single Icon field with a Symbol / Image segmented control, then the colours", () => {
        const html = sheetWith({});
        expect(html.match(/data-role="icon-field"/g)).toHaveLength(1);
        expect(html).toMatch(
            /role="group" aria-labelledby="([^"]+)" data-role="icon-field"><div[^>]*><div id="\1"[^>]*>Icon<\/div>/
        );
        const segments = [
            ...html.matchAll(/role="radio" aria-checked="(true|false)" tabindex="-?\d"[^>]*>(Symbol|Image)</g),
        ];
        expect(segments.map((m) => [m[2], m[1]])).toEqual([
            ["Symbol", "true"],
            ["Image", "false"],
        ]);
        expect(html.indexOf('data-role="icon-field"')).toBeLessThan(html.indexOf(">Colour<"));
        expect(html).not.toContain("Import image…");
        expect(html).not.toContain("Other image…");
        expect(html).not.toContain('data-action="use-symbol"');
    });

    it("opens on Image while an image shows in the rail", () => {
        expect(initialIconMode({ ...ws, meta: {} } as any)).toBe("symbol");
        expect(initialIconMode({ ...ws, meta: { "molten:projectlogo": "/p/logo.svg" } } as any)).toBe("image");
        expect(initialIconMode({ ...ws, meta: { "molten:workspaceicon": Stored } } as any)).toBe("image");
        expect(initialIconMode({ ...ws, meta: { "molten:workspaceicon": "/etc/passwd" } } as any)).toBe("symbol");
        expect(sheetWith({ "molten:projectlogo": "/p/logo.svg" })).toContain('data-role="image-pane"');
    });

    it("lists the project's images first, then the imported image, then the import tile", () => {
        const html = pane({ "molten:workspaceicon": Stored }, ["/p/icon.png", "/p/logo.svg"]);
        const order = [...html.matchAll(/data-image-kind="(project|imported)"|data-action="(import-image)"/g)].map(
            (m) => m[1] ?? m[2]
        );
        expect(order).toEqual(["project", "project", "imported", "import-image"]);
        expect(html).toContain('aria-label="Project image icon.png"');
        expect(html).toContain('aria-label="Replace the imported image…"');
        expect(html).toMatch(/role="status" aria-live="polite" data-role="icon-import-result"/);
    });

    it("marks the project image in use, and keeps a chosen one listed even when no longer found", () => {
        const html = pane({ "molten:projectlogo": "/elsewhere/brand.png" }, ["/p/icon.png"]);
        const pressed = [...html.matchAll(/aria-pressed="(true|false)" aria-label="Project image ([^"]+)"/g)];
        expect(pressed.map((m) => [m[2], m[1]])).toEqual([
            ["brand.png", "true"],
            ["icon.png", "false"],
        ]);
        expect(html).toContain('aria-label="Import an image…"');
        expect(html).not.toContain('data-image-kind="imported"');
    });

    it("shows the imported image in the preview, square and cropped", () => {
        const html = sheetWith({ "molten:workspaceicon": Stored, "molten:projectlogo": "/p/logo.svg" });
        expect(html).toContain('aria-label="Rail badge: Rocket, Blue, imported image"');
        const src = encodeURIComponent(`/data/workspace-icons/${Stored}`);
        expect(html).toMatch(
            new RegExp(
                `<img src="http://localhost/wave/stream-local-file\\?path=${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`
            )
        );
        expect(html).toMatch(/data-icon-kind="imported" decoding="async" class="[^"]*object-cover/);
    });

    it("previews the project logo when no image was imported, and the glyph otherwise", () => {
        expect(sheetWith({ "molten:projectlogo": "/p/logo.svg" })).toContain(
            'aria-label="Rail badge: Rocket, Blue, project logo"'
        );
        const plain = sheetWith({});
        expect(plain).toContain('aria-label="Rail badge: Rocket, Blue"');
        expect(plain).toMatch(
            /<i class="[^"]*fa-rocket[^"]*molten-glyph-tone[^"]*" style="--mt-glyph-color:#429DFF" data-icon-kind="builtin"/
        );
    });

    it("ignores a meta value that is not a stored name", () => {
        const html = sheetWith({ "molten:workspaceicon": "/etc/passwd" });
        expect(html).not.toContain("passwd");
        expect(html).toContain('data-icon-kind="builtin"');
    });
});

describe("icon and colour choices are named radio groups (NFR-SHELL-014)", () => {
    it("names each icon, marks the chosen one and gives it the only tab stop", () => {
        const html = renderToStaticMarkup(
            <IconChoices icons={["rocket", "star", "mug-hot"]} selected="star" color="#429DFF" onSelect={() => {}} />
        );
        expect(html).toMatch(
            /<div id="([^"]+)" class="sr-only">Symbol<\/div><div role="radiogroup" aria-labelledby="\1"/
        );
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
