// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { current, look } = vi.hoisted(() => ({
    current: { ws: null as Workspace },
    look: { scope: "workspace" as "workspace" | "project" },
}));

vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    useWaveObjectValue: () => [current.ws, false],
}));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom(null) }, getApi: () => ({ getDataDir: () => "/data" }) };
});
vi.mock("@/app/store/services", () => ({ WorkspaceService: {} }));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://localhost" }));
vi.mock("./workspace-edit", () => ({
    WorkspaceEditModel: { getInstance: () => ({}) },
    listenWorkspaceMenu: () => {},
    pickUpWorkspaceEdit: () => false,
    openProjectSheet: () => {},
}));
vi.mock("./workspace-reset", () => ({ askResetWorkspace: () => {}, askDeleteWorkspace: () => {} }));
vi.mock("./sidebar/sidebar-store", async () => {
    const { atom } = await import("jotai");
    const enabledAtom = atom(false);
    return { SidebarModel: { getInstance: () => ({ enabledAtom }) } };
});
vi.mock("./workspace-project-store", () => ({
    chooseMoltentermPath: async () => null,
    findProjectLogos: async () => [],
    setWorkspaceLogo: async () => {},
    setWorkspaceGradient: async () => {},
}));
vi.mock("./workspace-project-section", () => ({
    WorkspaceProjectBlock: () => <div data-stub="project">Link a project…</div>,
    WorkspaceFolderLine: () => <div data-stub="folder">Change…</div>,
}));
vi.mock("./window-look-field", () => ({
    OpacityField: () => <div data-stub="opacity">Opacity</div>,
    useLookScope: () => look.scope,
}));
// The real frame portals into document.body; the sheet's content is what is checked here.
vi.mock("./dialog-frame", () => ({
    useEscape: () => {},
    DialogFrame: ({ role, title, subtitle, subtitleClass, subtitleTooltip, widthClass, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role} data-width={widthClass}>
            <div data-subtitle={subtitleClass} title={subtitleTooltip}>
                {subtitle}
            </div>
            {children}
            {buttons}
        </div>
    ),
}));

import { getDefaultStore, PrimitiveAtom } from "jotai";
import { SidebarModel } from "./sidebar/sidebar-store";
import {
    balancedColumns,
    ColourChoices,
    ColourField,
    IconChoices,
    IconGridMaxColumns,
    ImagePane,
    initialIconMode,
    LogoField,
    WorkspaceEditSheet,
} from "./workspace-edit-sheet";
import { projectLogoOf, readWorkspaceProject } from "./workspace-project";

const ws = { oid: "w1", name: "Client A", icon: "rocket", color: "#429DFF", meta: {} } as any as Workspace;

function sheet(closable: boolean) {
    current.ws = ws;
    return renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable={closable} onClose={() => {}} />);
}

describe("workspace edit sheet (FR-SHELL-030-AC5…AC8)", () => {
    it("is one MoltenTerm dialog titled Workspace, with its folder's name in mono 11 under the title (DS-SHELL-101, #751)", () => {
        const html = sheet(true);
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-label="Edit workspace"');
        expect(html).toContain('data-role="workspace-edit"');
        expect(html).toContain('<div data-subtitle="font-mono text-11"></div>');
        current.ws = { ...ws, meta: { "molten:folder": "/Users/me/code/client-a" } } as any as Workspace;
        expect(renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable onClose={() => {}} />)).toContain(
            '<div data-subtitle="font-mono text-11" title="/Users/me/code/client-a">client-a</div>'
        );
        expect(html).toContain('data-width="w-fit max-w-[min(560px,calc(100vw-32px))]"');
        expect(html).not.toContain("workspace-editor");
    });

    it("lays out Identity, Appearance, Projects and the Danger zone, each a suite block with its heading (FR-SHELL-105)", () => {
        const html = sheet(true);
        const headings = [...html.matchAll(/<h3 id="[^"]+"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
        expect(headings).toEqual(["Identity", "Appearance", "Projects", "Danger zone"]);
        expect([...html.matchAll(/<section aria-labelledby="([^"]+)"/g)]).toHaveLength(4);
        expect(html.match(/class="df-icon-tile"/g)).toHaveLength(4);
        expect(html.indexOf('data-stub="project"')).toBeLessThan(html.indexOf('data-stub="folder"'));
    });

    // The scope tag of each block, in order (FR-SHELL-101): Appearance follows "Apply to".
    function scopes(html: string): string[] {
        return html
            .split(/<section /)
            .slice(1)
            .map((s) => /data-scope="([^"]+)"/.exec(s)?.[1]);
    }

    it("tags every block with its scope, Appearance with the project when the look is saved there", () => {
        expect(scopes(sheet(true))).toEqual(["workspace", "workspace", "workspace", "workspace"]);
        look.scope = "project";
        try {
            expect(scopes(sheet(true))).toEqual(["workspace", "project", "workspace", "workspace"]);
        } finally {
            look.scope = "workspace";
        }
    });

    // Each field in the part the placement table names, and in only one (TC-SHELL-206).
    function fieldsByPart(html: string): Record<string, string[]> {
        const sections = html.split(/<section /).slice(1);
        const rtn: Record<string, string[]> = {};
        for (const section of sections) {
            const title = /<h3 id="[^"]+"[^>]*>([^<]+)<\/h3>/.exec(section)?.[1];
            rtn[title] = [...section.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]);
        }
        return rtn;
    }

    it("puts name, icon and colour under Identity, the look under Appearance, the projects and folder under Projects", () => {
        const linked = {
            ...ws,
            meta: {
                "molten:project": "/code/client-a",
                "molten:projecttype": "Desktop",
                "molten:projectlogo": "/code/client-a/icon.png",
            },
        } as any as Workspace;
        current.ws = linked;
        const html = renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable onClose={() => {}} />);
        expect(fieldsByPart(html)).toEqual({
            Identity: ["name", "icon", "useProjectLogo", "colour"],
            Appearance: ["look"],
            Projects: ["projects", "folder"],
            "Danger zone": [],
        });
        expect(html).toMatch(/data-project="p1"[\s\S]*Desktop[\s\S]*\/code\/client-a/);
        expect(html).toMatch(/data-action="project-sheet" class="[^"]*cursor-pointer[^"]*">Set up the project ›/);
        expect(html).toMatch(/role="switch" aria-checked="true"[^>]*data-action="use-project-logo"/);
        expect(html).toContain("Use the project&#x27;s logo");
        expect(html).not.toContain('data-image-kind="project"');
        expect(html).not.toContain('data-role="logo-choices"');
    });

    it("lists every project of the workspace, the current one marked, each with its way to the Project sheet", () => {
        current.ws = {
            ...ws,
            meta: {
                "molten:project": "/code/desk",
                "molten:projecttype": "Desktop",
                "molten:currentproject": "p2",
                "molten:projects": [
                    { id: "p1", type: "Website", dir: "/code/site", branch: "main" },
                    { id: "p2", type: "Desktop", dir: "/code/desk" },
                ],
            },
        } as any as Workspace;
        const html = renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable onClose={() => {}} />);
        expect(html.match(/data-action="project-sheet"/g)).toHaveLength(2);
        expect(html).toMatch(
            /data-project="p1"[\s\S]*Website[\s\S]*main[\s\S]*data-project="p2"[\s\S]*Desktop[\s\S]*current/
        );
    });

    it("offers to link a project when none is linked, and keeps the folder, without blocking the rest (TC-SHELL-207)", () => {
        const html = sheet(true);
        expect(fieldsByPart(html).Projects).toEqual(["projects", "folder"]);
        expect(html).toContain('data-stub="project"');
        expect(html).not.toContain("disabled");
        expect(fieldsByPart(html).Identity).toEqual(["name", "icon", "colour"]);
    });

    it("holds a labelled name field and a preview of the rail badge at its real size", () => {
        const html = sheet(true);
        expect(html).toMatch(/<label for="([^"]+)"[^>]*>Name<\/label><input id="\1"/);
        expect(html).toContain('value="Client A"');
        expect(html).toContain('aria-invalid="false"');
        expect(html).toMatch(/data-role="rail-preview" class="[^"]*\bh-9 w-9\b[^"]*text-icon-16/);
        expect(html).toContain('aria-label="Sidebar badge: Rocket, Blue"');
        expect(html).toContain("In the sidebar");
    });

    it("names the sidebar under the badge preview when the workspace sidebar is on (#1183)", () => {
        const enabledAtom = SidebarModel.getInstance().enabledAtom as PrimitiveAtom<boolean>;
        getDefaultStore().set(enabledAtom, true);
        try {
            const html = sheet(true);
            expect(html).toContain("In the sidebar");
        } finally {
            getDefaultStore().set(enabledAtom, false);
        }
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

    function pane(meta: Record<string, any>) {
        return renderToStaticMarkup(
            <ImagePane
                ws={{ ...ws, meta } as any as Workspace}
                over={false}
                busy={false}
                result={null}
                dropHandlers={{}}
                onPick={() => {}}
            />
        );
    }

    function logoField(meta: Record<string, any>, logos: string[]) {
        const shown = { ...ws, meta } as any as Workspace;
        const current = projectLogoOf(readWorkspaceProject(shown), "/", logos);
        return renderToStaticMarkup(<LogoField ws={shown} logos={logos} current={current} onLogo={() => {}} />);
    }

    it("shows a single Icon field with a Symbol / Image segmented control, then the colours", () => {
        const html = sheetWith({});
        expect(html.match(/data-role="icon-field"/g)).toHaveLength(1);
        expect(html).toMatch(
            /role="group" aria-labelledby="([^"]+)" data-role="icon-field" data-field="icon"><div[^>]*><div id="\1"[^>]*>Icon<\/div>/
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

    it("shows the imported image, then the import tile; the project's images are the Project part's Logo (#1280)", () => {
        const html = pane({ "molten:workspaceicon": Stored });
        const order = [...html.matchAll(/data-image-kind="(project|imported)"|data-action="(import-image)"/g)].map(
            (m) => m[1] ?? m[2]
        );
        expect(order).toEqual(["imported", "import-image"]);
        expect(html).toContain('aria-label="Replace the imported image…"');
        expect(html).toMatch(/role="status" aria-live="polite" data-role="icon-import-result"/);
        expect(html).not.toContain('data-role="project-logo-in-use"');
    });

    it("says on the Image side when the project's logo is in use (TC-SHELL-208)", () => {
        const html = pane({ "molten:projectlogo": "/p/logo.svg" });
        expect(html).toContain("The project&#x27;s logo is in use: turn off “Use the project&#x27;s logo” below");
        expect(html).toContain('aria-label="Import an image…"');
        expect(html).not.toContain('data-image-kind="project"');
    });

    it("lists the project's images in Logo, marks the project's logo, and keeps a chosen one listed when no longer found", () => {
        const html = logoField({ "molten:projectlogochoice": "/elsewhere/brand.png" }, ["/p/icon.png"]);
        const pressed = [...html.matchAll(/aria-pressed="(true|false)" aria-label="Project image ([^"]+)"/g)];
        expect(pressed.map((m) => [m[2], m[1]])).toEqual([
            ["brand.png", "true"],
            ["icon.png", "false"],
        ]);
        expect(html).toContain("cursor-pointer");
        // The project's logo stays chosen while the workspace shows an imported image (FR-SHELL-105).
        expect(logoField({ "molten:workspaceicon": Stored }, ["/p/icon.png"])).toContain('aria-pressed="true"');
        expect(logoField({}, [])).toContain("No image found in the project.");
    });

    it("shows the imported image in the preview, square and fitted whole", () => {
        const html = sheetWith({ "molten:workspaceicon": Stored, "molten:projectlogo": "/p/logo.svg" });
        expect(html).toContain('aria-label="Sidebar badge: Rocket, Blue, imported image"');
        const src = encodeURIComponent(`/data/workspace-icons/${Stored}`);
        expect(html).toMatch(
            new RegExp(
                `<img src="http://localhost/wave/stream-local-file\\?path=${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`
            )
        );
        expect(html).toMatch(/data-icon-kind="imported" decoding="async" class="[^"]*object-contain/);
    });

    it("previews the project logo when no image was imported, and the glyph otherwise", () => {
        expect(sheetWith({ "molten:projectlogo": "/p/logo.svg" })).toContain(
            'aria-label="Sidebar badge: Rocket, Blue, project logo"'
        );
        const plain = sheetWith({});
        expect(plain).toContain('aria-label="Sidebar badge: Rocket, Blue"');
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
        expect(html).toContain("grid-template-columns:repeat(3, max-content)");
    });

    it("lays the symbols out in even rows, never one alone on the last (#751)", () => {
        expect(balancedColumns(14, IconGridMaxColumns)).toBe(7);
        expect(balancedColumns(13, 7)).toBe(7);
        expect(balancedColumns(15, 7)).toBe(5);
        expect(balancedColumns(3, 7)).toBe(3);
        expect(balancedColumns(0, 7)).toBe(1);
        for (let count = 1; count <= 40; count++) {
            const columns = balancedColumns(count, IconGridMaxColumns);
            const last = count - (Math.ceil(count / columns) - 1) * columns;
            expect(columns).toBeLessThanOrEqual(IconGridMaxColumns);
            if (count > columns) {
                expect(last).toBeGreaterThan(1);
            }
        }
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

describe("colour field (#657)", () => {
    const groups = (html: string) => [...html.matchAll(/class="mb-1 text-11 text-muted">([^<]+)</g)].map((m) => m[1]);

    it("offers the logo's colours and gradients first, then the presets, the gradients and a custom colour", () => {
        const html = renderToStaticMarkup(
            <ColourField selected="#429dff" logoColours={["#E34F26", "#1572B6"]} onSelect={() => {}} />
        );
        expect(groups(html)).toEqual(["From the logo", "Colours", "Gradients", "Custom"]);
        expect(html).toContain('aria-label="Logo colour #e34f26"');
        expect(html).toContain('aria-label="Logo gradient #e34f26, #1572b6"');
        expect(html).toContain("background:linear-gradient(135deg, #e34f26, #1572b6)");
        expect(html.match(/role="radio"/g)).toHaveLength(3 + 24 + 5);
        expect(html).toContain('aria-label="Pick a custom colour"');
        expect(html).toMatch(/aria-checked="true" aria-label="Blue"/);
        expect(html.match(/fa-check/g)).toHaveLength(1);
    });

    it("has no logo row without an image, and checks a gradient in its row (#657 AC3)", () => {
        const html = renderToStaticMarkup(
            <ColourField selected="#00ffdb,#429dff" logoColours={[]} onSelect={() => {}} />
        );
        expect(groups(html)).toEqual(["Colours", "Gradients", "Custom"]);
        expect(html).toMatch(/aria-checked="true" aria-label="Ocean"/);
        expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    });

    it("shows a colour from before as selected, and an unknown one as the custom colour (#657 AC4)", () => {
        const wave = renderToStaticMarkup(<ColourField selected="#58c142" logoColours={[]} onSelect={() => {}} />);
        expect(wave).toMatch(/aria-checked="true" aria-label="Green"/);
        const custom = renderToStaticMarkup(<ColourField selected="#123456" logoColours={[]} onSelect={() => {}} />);
        expect(custom).not.toContain('aria-checked="true"');
        expect(custom).toContain('value="#123456"');
        expect(custom.match(/fa-check/g)).toHaveLength(1);
    });

    it("is the sheet's colour field, its choice read from the workspace's gradient", () => {
        current.ws = { ...ws, color: "#00ffdb", meta: { "molten:workspacegradient": "#00ffdb,#429dff" } } as any;
        const html = renderToStaticMarkup(<WorkspaceEditSheet workspaceId="w1" closable onClose={() => {}} />);
        expect(html).toContain('data-role="colour-field"');
        expect(html).toMatch(/aria-checked="true" aria-label="Ocean"/);
        expect(html).toContain("Sidebar badge: Rocket, Ocean");
        expect(html).toContain("molten-glyph-gradient");
    });
});
