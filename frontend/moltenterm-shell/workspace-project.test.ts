// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    boundingFolder,
    boundingScope,
    canResetWorkspaceFolder,
    checkAbsolutePath,
    checkPathInside,
    declaredProjectIcon,
    effectiveWorkspaceFolder,
    isOutsideContextFolder,
    isProjectOutsideBound,
    linkUpdate,
    logoProbeOrder,
    logoUrl,
    nextWorkspaceFolder,
    pathBaseName,
    pathParent,
    projectBound,
    projectFilePath,
    ProjectLogoChoiceMetaKey,
    ProjectLogoMetaKey,
    projectLogoOf,
    ProjectLogoOfferMetaKey,
    projectLogoUpdate,
    ProjectMetaKey,
    projectName,
    ProjectRepoMetaKey,
    projectRepoOf,
    readChosenWorkspaceFolder,
    readmeFirstImage,
    readWorkspaceFolder,
    readWorkspaceProject,
    repositoryLabel,
    repositoryValues,
    shouldOfferLogo,
    unlinkUpdate,
    WorkspaceFolderChosenMetaKey,
    WorkspaceFolderMetaKey,
    workspaceFolderView,
} from "./workspace-project";

function ws(meta: Record<string, any>): Workspace {
    return { oid: "w", meta, tabids: [], activetabid: "", otype: "workspace", version: 1 } as Workspace;
}

describe("readWorkspaceProject", () => {
    it("reads the link and the logo from the workspace meta", () => {
        expect(readWorkspaceProject(ws({ [ProjectMetaKey]: "/p", [ProjectLogoMetaKey]: "/p/icon.png" }))).toEqual({
            dir: "/p",
            repo: "/p",
            logo: "/p/icon.png",
            logoOffer: "",
            logoChoice: "",
        });
        expect(readWorkspaceProject(ws(null))).toEqual({ dir: "", repo: "", logo: "", logoOffer: "", logoChoice: "" });
        expect(readWorkspaceProject(ws({ [ProjectMetaKey]: 42 })).dir).toBe("");
    });
});

describe("a project's folder and its code repository (#1777)", () => {
    it("reads the repository chosen inside the folder, else the folder itself", () => {
        const read = (meta: Record<string, any>) =>
            readWorkspaceProject(ws({ [ProjectMetaKey]: "/clients/ofpis", ...meta }));
        expect(read({ [ProjectRepoMetaKey]: "/clients/ofpis/app" })).toMatchObject({
            dir: "/clients/ofpis",
            repo: "/clients/ofpis/app",
        });
        expect(read({ [ProjectRepoMetaKey]: "/clients/ofpis/code/api/" }).repo).toBe("/clients/ofpis/code/api");
        expect(read({}).repo).toBe("/clients/ofpis");
        expect(read({ [ProjectRepoMetaKey]: "" }).repo).toBe("/clients/ofpis");
    });

    it("falls back to the folder for a repository that is not usable", () => {
        expect(projectRepoOf("/clients/ofpis", "/clients/ofpis")).toBe("/clients/ofpis");
        expect(projectRepoOf("/clients/ofpis", "/clients/ofpis/")).toBe("/clients/ofpis");
        expect(projectRepoOf("/clients/ofpis", "/clients/other/app")).toBe("/clients/ofpis");
        expect(projectRepoOf("/clients/ofpis", "/clients/ofpis-old")).toBe("/clients/ofpis");
        expect(projectRepoOf("/clients/ofpis", "app")).toBe("/clients/ofpis");
        expect(projectRepoOf("", "/clients/ofpis/app")).toBe("");
        expect(readWorkspaceProject(ws({ [ProjectRepoMetaKey]: "/x/app" })).repo).toBe("");
    });

    it("names a repository from the folder, and always offers the one already chosen", () => {
        expect(repositoryLabel("/clients/ofpis", "/clients/ofpis/app")).toBe("app");
        expect(repositoryLabel("/clients/ofpis/", "/clients/ofpis/code/api")).toBe("code/api");
        expect(repositoryLabel("/clients/ofpis", "/elsewhere")).toBe("/elsewhere");
        const found = ["/clients/ofpis/app", "/clients/ofpis/code/api"];
        expect(repositoryValues("/clients/ofpis", found, "")).toEqual(found);
        expect(repositoryValues("/clients/ofpis", found, "/clients/ofpis/code/api")).toEqual(found);
        expect(repositoryValues("/clients/ofpis", found, "/clients/ofpis/old/deep/repo")).toEqual([
            ...found,
            "/clients/ofpis/old/deep/repo",
        ]);
        expect(repositoryValues("/clients/ofpis", null, "")).toEqual([]);
    });

    it("drops the repository when the workspace is linked to another folder, or unlinked", () => {
        const current = { dir: "/a", repo: "/a/app", logo: "", logoOffer: "" };
        expect(linkUpdate(current, "/a")).toEqual({ [ProjectMetaKey]: "/a" });
        expect(linkUpdate(current, "/b")[ProjectRepoMetaKey]).toBeNull();
        expect(unlinkUpdate()[ProjectRepoMetaKey]).toBeNull();
    });
});

describe("the project's logo, chosen in the Project sheet only (FR-SHELL-105)", () => {
    const project = (meta: Record<string, any>) => readWorkspaceProject(ws({ [ProjectMetaKey]: "/p", ...meta }));

    it("is the chosen one, else the one shown, else the first image found", () => {
        const found = ["/p/icon.png", "/p/logo.svg"];
        expect(projectLogoOf(project({ [ProjectLogoChoiceMetaKey]: "/p/logo.svg" }), "/p", found)).toBe("/p/logo.svg");
        expect(projectLogoOf(project({ [ProjectLogoMetaKey]: "/p/brand.png" }), "/p", found)).toBe("/p/brand.png");
        expect(projectLogoOf(project({}), "/p", found)).toBe("/p/icon.png");
        expect(projectLogoOf(project({}), "/p", [])).toBe("");
    });

    it("ignores a choice made for another folder", () => {
        expect(projectLogoOf(project({ [ProjectLogoChoiceMetaKey]: "/old/icon.png" }), "/p", ["/p/icon.png"])).toBe(
            "/p/icon.png"
        );
    });

    it("moves the workspace's icon only when it already shows the project's logo", () => {
        expect(projectLogoUpdate(project({}), "/p/logo.svg")).toEqual({ [ProjectLogoChoiceMetaKey]: "/p/logo.svg" });
        expect(projectLogoUpdate(project({ [ProjectLogoMetaKey]: "/p/icon.png" }), "/p/logo.svg")).toEqual({
            [ProjectLogoChoiceMetaKey]: "/p/logo.svg",
            [ProjectLogoMetaKey]: "/p/logo.svg",
        });
    });
});

describe("paths", () => {
    it("names and parents", () => {
        expect(pathBaseName("/Users/a/Notulia/")).toBe("Notulia");
        expect(pathParent("/Users/a/Notulia")).toBe("/Users/a");
        expect(pathParent("/Users")).toBe("/");
        expect(pathParent("/")).toBe("");
    });

    it("keeps project files inside the project", () => {
        expect(projectFilePath("/p", "./public/logo.svg")).toBe("/p/public/logo.svg");
        expect(projectFilePath("/p/", "docs/../x.png")).toBeNull();
        expect(projectFilePath("C:\\p", "public/logo.svg")).toBe("C:\\p\\public\\logo.svg");
    });
});

describe("readmeFirstImage", () => {
    it("skips badges and web images", () => {
        const readme =
            '[![CI](https://example.com/badge.svg)](x)\n<p><img src="./docs/brand/mark.svg" width="40"></p>\n![shot](shot.png)';
        expect(readmeFirstImage(readme)).toBe("docs/brand/mark.svg");
    });

    it("reads markdown images with a title", () => {
        expect(readmeFirstImage('# T\n![logo](assets/brand.png "Logo")')).toBe("assets/brand.png");
        expect(readmeFirstImage("no image")).toBe("");
    });
});

describe("logoProbeOrder", () => {
    it("probes app icons before favicons and the README's image last", () => {
        const order = logoProbeOrder("docs/brand/mark.svg");
        expect(order.indexOf("src-tauri/icons/icon.png")).toBeLessThan(order.indexOf("public/favicon.svg"));
        expect(order[order.length - 1]).toBe("docs/brand/mark.svg");
        expect(logoProbeOrder("docs/readme.gif?raw=1")).not.toContain("docs/readme.gif?raw=1");
    });

    it("probes the icon the project declares first, once", () => {
        const order = logoProbeOrder("", declaredProjectIcon({ icon: "./build/app/icon.svg" }));
        expect(order[0]).toBe("build/app/icon.svg");
        expect(logoProbeOrder("", "icon.png").filter((rel) => rel === "icon.png")).toHaveLength(1);
        expect(declaredProjectIcon(null)).toBe("");
        expect(declaredProjectIcon({ icon: 3 })).toBe("");
    });
});

describe("logo offer and link updates", () => {
    it("offers the logo once per project, only while the workspace shows its own icon", () => {
        const linked = { dir: "/p", logo: "", logoOffer: "" };
        expect(shouldOfferLogo(linked, ["/p/icon.png"])).toBe(true);
        expect(shouldOfferLogo(linked, [])).toBe(false);
        expect(shouldOfferLogo({ ...linked, logoOffer: "/p" }, ["/p/icon.png"])).toBe(false);
        expect(shouldOfferLogo({ ...linked, logo: "/p/icon.png" }, ["/p/icon.png"])).toBe(false);
        expect(shouldOfferLogo({ dir: "", logo: "", logoOffer: "" }, ["/p/icon.png"])).toBe(false);
    });

    it("drops the logo when the workspace is linked to another project", () => {
        const current = { dir: "/a", logo: "/a/icon.png", logoOffer: "/a" };
        expect(linkUpdate(current, "/a")).toEqual({ [ProjectMetaKey]: "/a" });
        expect(linkUpdate(current, "/b")).toEqual({
            [ProjectMetaKey]: "/b",
            [ProjectLogoMetaKey]: null,
            [ProjectRepoMetaKey]: null,
        });
        expect(unlinkUpdate()).toEqual({
            [ProjectMetaKey]: null,
            [ProjectRepoMetaKey]: null,
            [ProjectLogoMetaKey]: null,
            [ProjectLogoOfferMetaKey]: null,
        });
    });

    it("streams the logo through wavesrv", () => {
        expect(logoUrl("http://127.0.0.1:1", "/p/a b.png")).toBe(
            "http://127.0.0.1:1/wave/stream-local-file?path=%2Fp%2Fa%20b.png"
        );
    });
});

describe("projectName", () => {
    it("follows molten's order", () => {
        expect(projectName("/a/morphterm", { name: "Pipe" }, { projectName: "moltenterm" }, { name: "pkg" })).toBe(
            "Pipe"
        );
        expect(projectName("/a/morphterm", null, { projectName: "moltenterm" }, { name: "pkg" })).toBe("moltenterm");
        expect(projectName("/a/morphterm", null, null, { name: "pkg" })).toBe("pkg");
        expect(projectName("/a/morphterm", null, null, null)).toBe("morphterm");
    });
});

describe("workspace folder (FR-SHELL-009)", () => {
    it("tells whether a path lies in a folder", () => {
        expect(checkPathInside("/p/app", "/p/app")).toBe(true);
        expect(checkPathInside("/p/app/src/ui", "/p/app/")).toBe(true);
        expect(checkPathInside("/p/application", "/p/app")).toBe(false);
        expect(checkPathInside("/p", "/p/app")).toBe(false);
        expect(checkPathInside("/anything", "/")).toBe(true);
        expect(checkPathInside("C:\\p\\app\\src", "C:\\p\\app")).toBe(true);
        expect(checkPathInside("", "/p")).toBe(false);
    });

    it("recognises absolute paths only", () => {
        expect(checkAbsolutePath("/Users/me")).toBe(true);
        expect(checkAbsolutePath("C:\\Users\\me")).toBe(true);
        expect(checkAbsolutePath("~/code")).toBe(false);
        expect(checkAbsolutePath("")).toBe(false);
    });

    it("reads the stored folder and bounds it by the linked project", () => {
        expect(readWorkspaceFolder(ws({ [WorkspaceFolderMetaKey]: "/tmp" }))).toBe("/tmp");
        expect(effectiveWorkspaceFolder(ws({}))).toBe("");
        expect(effectiveWorkspaceFolder(ws({ [WorkspaceFolderMetaKey]: "/tmp" }))).toBe("/tmp");
        expect(effectiveWorkspaceFolder(ws({ [WorkspaceFolderMetaKey]: "/p/src", [ProjectMetaKey]: "/p" }))).toBe(
            "/p/src"
        );
        expect(effectiveWorkspaceFolder(ws({ [WorkspaceFolderMetaKey]: "/tmp", [ProjectMetaKey]: "/p" }))).toBe("/p");
        expect(effectiveWorkspaceFolder(ws({ [ProjectMetaKey]: "/p" }))).toBe("/p");
    });

    it("follows the terminal, inside the linked project only", () => {
        expect(nextWorkspaceFolder("", "", "/Users/me/code/app")).toBe("/Users/me/code/app");
        expect(nextWorkspaceFolder("/a", "", "/b/")).toBe("/b");
        expect(nextWorkspaceFolder("/p/src", "/p", "/p/docs")).toBe("/p/docs");
        expect(nextWorkspaceFolder("/p/src", "/p", "/tmp")).toBeNull();
        expect(nextWorkspaceFolder("/p/src", "/p", "/p/src")).toBeNull();
        expect(nextWorkspaceFolder("", "", "~/code")).toBeNull();
        expect(nextWorkspaceFolder("", "", "")).toBeNull();
    });

    // #2516: the folder chosen with Change… was overwritten as soon as the focused terminal reported its own folder.
    it("never lets the terminal replace a folder chosen in the settings", () => {
        expect(nextWorkspaceFolder("/clients/sefers", "", "/Users/me", true)).toBeNull();
        expect(nextWorkspaceFolder("/clients/sefers", "", "/clients/sefers/docs", true)).toBeNull();
    });

    // #2516: context ⊃ workspace ⊃ project, a new panel starts at the narrowest root that applies.
    it("bounds the workspace by its context, its chosen folder and its project", () => {
        const chosen = (folder: string, more: Record<string, any> = {}) =>
            ws({ [WorkspaceFolderMetaKey]: folder, [WorkspaceFolderChosenMetaKey]: true, ...more });
        expect(readChosenWorkspaceFolder(ws({ [WorkspaceFolderMetaKey]: "/tmp" }))).toBe("");
        expect(readChosenWorkspaceFolder(chosen("/w"))).toBe("/w");
        expect(boundingFolder(ws({}), "/c")).toBe("/c");
        expect(effectiveWorkspaceFolder(ws({}), "/c")).toBe("/c");
        expect(effectiveWorkspaceFolder(ws({ [WorkspaceFolderMetaKey]: "/c/x" }), "/c")).toBe("/c/x");
        expect(effectiveWorkspaceFolder(ws({ [WorkspaceFolderMetaKey]: "/Users/me" }), "/c")).toBe("/c");
        expect(boundingFolder(chosen("/c/w"), "/c")).toBe("/c/w");
        expect(boundingFolder(chosen("/elsewhere"), "/c")).toBe("/elsewhere");
        expect(boundingFolder(chosen("/w", { [ProjectMetaKey]: "/w/p" }))).toBe("/w/p");
        expect(boundingFolder(chosen("/w", { [ProjectMetaKey]: "/q" }))).toBe("/w");
        expect(boundingFolder(ws({ [ProjectMetaKey]: "/q" }), "/c")).toBe("/c");
        expect(effectiveWorkspaceFolder(chosen("/c/w", { [ProjectMetaKey]: "/c/w/p" }), "/c")).toBe("/c/w/p");
        expect(effectiveWorkspaceFolder(chosen("/w"))).toBe("/w");
    });

    // #2518: the level that sets the bound is the one the file panel's texts name.
    it("names the level that sets the bound", () => {
        const chosen = (folder: string, more: Record<string, any> = {}) =>
            ws({ [WorkspaceFolderMetaKey]: folder, [WorkspaceFolderChosenMetaKey]: true, ...more });
        expect(boundingScope(ws({}))).toBe("");
        expect(boundingScope(ws({ [WorkspaceFolderMetaKey]: "/followed" }))).toBe("");
        expect(boundingScope(ws({ [ProjectMetaKey]: "/p" }))).toBe("project");
        expect(boundingScope(chosen("/w"))).toBe("workspace");
        expect(boundingScope(ws({}), "/c")).toBe("context");
        expect(boundingScope(ws({ [WorkspaceFolderMetaKey]: "/c/x" }), "/c")).toBe("context");
        expect(boundingScope(chosen("/c/w"), "/c")).toBe("workspace");
        expect(boundingScope(chosen("/elsewhere"), "/c")).toBe("workspace");
        expect(boundingScope(chosen("/w", { [ProjectMetaKey]: "/w/p" }), "/c")).toBe("project");
        expect(boundingScope(ws({ [ProjectMetaKey]: "/c/p" }), "/c")).toBe("project");
        expect(boundingScope(chosen("/w", { [ProjectMetaKey]: "/q" }))).toBe("workspace");
        expect(boundingScope(ws({ [ProjectMetaKey]: "/q" }), "/c")).toBe("context");
    });

    it("always names the scope whose folder boundingFolder returns", () => {
        const cases: [Workspace, string][] = [
            [ws({}), ""],
            [ws({ [ProjectMetaKey]: "/p" }), ""],
            [ws({ [WorkspaceFolderMetaKey]: "/w", [WorkspaceFolderChosenMetaKey]: true }), "/c"],
            [
                ws({ [WorkspaceFolderMetaKey]: "/w", [WorkspaceFolderChosenMetaKey]: true, [ProjectMetaKey]: "/w/p" }),
                "/c",
            ],
            [ws({ [ProjectMetaKey]: "/q" }), "/c"],
        ];
        for (const [workspace, contextFolder] of cases) {
            const scope = boundingScope(workspace, contextFolder);
            const folder = boundingFolder(workspace, contextFolder);
            expect(scope === "").toBe(folder === "");
            if (scope === "project") {
                expect(folder).toBe(readWorkspaceProject(workspace).dir);
            } else if (scope === "workspace") {
                expect(folder).toBe(readChosenWorkspaceFolder(workspace));
            } else if (scope === "context") {
                expect(folder).toBe(contextFolder);
            }
        }
    });
});

// #2518: the workspace sheet's Folder line says where the folder comes from, in one line.
describe("the workspace's Folder line", () => {
    const chosen = (folder: string, more: Record<string, any> = {}) =>
        ws({ [WorkspaceFolderMetaKey]: folder, [WorkspaceFolderChosenMetaKey]: true, ...more });

    it("shows the folder chosen for the workspace, whatever its context sets", () => {
        expect(workspaceFolderView(chosen("/c/w"), "/c")).toEqual({ kind: "chosen", folder: "/c/w" });
        expect(workspaceFolderView(chosen("/elsewhere"), "/c")).toEqual({ kind: "chosen", folder: "/elsewhere" });
        expect(workspaceFolderView(chosen("/w"), "")).toEqual({ kind: "chosen", folder: "/w" });
    });

    it("says the folder is the context's when none is chosen, even if the terminal went elsewhere", () => {
        expect(workspaceFolderView(ws({}), "/c")).toEqual({ kind: "inherited", folder: "/c" });
        expect(workspaceFolderView(ws({ [WorkspaceFolderMetaKey]: "/Users/me" }), "/c")).toEqual({
            kind: "inherited",
            folder: "/c",
        });
    });

    it("keeps what it showed before when the context sets no folder", () => {
        expect(workspaceFolderView(ws({}), "")).toEqual({ kind: "none" });
        expect(workspaceFolderView(ws({ [WorkspaceFolderMetaKey]: "/tmp/x" }), "")).toEqual({
            kind: "followed",
            folder: "/tmp/x",
            outsideProject: false,
            stored: true,
        });
        expect(workspaceFolderView(ws({ [WorkspaceFolderMetaKey]: "/p/src", [ProjectMetaKey]: "/p" }), "")).toEqual({
            kind: "followed",
            folder: "/p/src",
            outsideProject: false,
            stored: true,
        });
        expect(workspaceFolderView(ws({ [WorkspaceFolderMetaKey]: "/tmp", [ProjectMetaKey]: "/p" }), "")).toEqual({
            kind: "followed",
            folder: "/p",
            outsideProject: true,
            stored: true,
        });
        expect(workspaceFolderView(ws({ [ProjectMetaKey]: "/p" }), "")).toEqual({
            kind: "followed",
            folder: "/p",
            outsideProject: false,
            stored: false,
        });
    });

    it("offers Reset for a chosen folder and for a followed one, never for the context's", () => {
        expect(canResetWorkspaceFolder(workspaceFolderView(chosen("/w"), "/c"))).toBe(true);
        expect(canResetWorkspaceFolder(workspaceFolderView(ws({ [WorkspaceFolderMetaKey]: "/tmp/x" }), ""))).toBe(true);
        expect(canResetWorkspaceFolder(workspaceFolderView(ws({}), "/c"))).toBe(false);
        expect(canResetWorkspaceFolder(workspaceFolderView(ws({}), ""))).toBe(false);
        expect(canResetWorkspaceFolder(workspaceFolderView(ws({ [ProjectMetaKey]: "/p" }), ""))).toBe(false);
    });
});

// #2518: a linked project outside the folder that bounds its workspace is only marked.
describe("a project outside the folder that bounds it", () => {
    const chosen = (folder: string) => ws({ [WorkspaceFolderMetaKey]: folder, [WorkspaceFolderChosenMetaKey]: true });

    it("is bounded by the workspace's folder, else by the context's, else by nothing", () => {
        expect(projectBound(chosen("/c/w"), "/c")).toBe("/c/w");
        expect(projectBound(ws({}), "/c")).toBe("/c");
        expect(projectBound(ws({ [WorkspaceFolderMetaKey]: "/followed" }), "")).toBe("");
    });

    it("is outside when it does not lie in that folder", () => {
        expect(isProjectOutsideBound("/c/w/app", chosen("/c/w"), "/c")).toBe(false);
        expect(isProjectOutsideBound("/c/w", chosen("/c/w"), "/c")).toBe(false);
        expect(isProjectOutsideBound("/c/other", chosen("/c/w"), "/c")).toBe(true);
        expect(isProjectOutsideBound("/c/w2", chosen("/c/w"), "/c")).toBe(true);
        expect(isProjectOutsideBound("/c/other", ws({}), "/c")).toBe(false);
        expect(isProjectOutsideBound("/q", ws({}), "/c")).toBe(true);
    });

    it("is never outside what bounds nothing, and an empty project is not one", () => {
        expect(isProjectOutsideBound("/anywhere", ws({}), "")).toBe(false);
        expect(isProjectOutsideBound("", chosen("/c/w"), "/c")).toBe(false);
    });
});

// #2518: a workspace folder outside its context's folder asks for the confirmation, and is never blocked. Only whole
// path elements count: a sibling that shares a prefix is outside.
describe("a workspace folder outside its context's folder", () => {
    const cases: [string, string, string, boolean][] = [
        ["the context's own folder", "/a/b", "/a/b", false],
        ["inside", "/a/b/c", "/a/b", false],
        ["trailing separators on both", "/a/b/c/", "/a/b/", false],
        ["the same folder with a trailing separator", "/a/b/", "/a/b", false],
        ["a sibling sharing the prefix", "/a/bc", "/a/b", true],
        ["a sibling sharing the prefix, trailing separator", "/a/bc/", "/a/b/", true],
        ["the parent", "/a", "/a/b", true],
        ["a folder named like a parent step", "/a/b/..c", "/a/b", false],
        ["leaving through a parent step", "/a/b/../c", "/a/b", true],
        ["coming back through a parent step", "/a/c/../b/x", "/a/b", false],
        ["a current-folder step", "/a/./b/./c", "/a/b", false],
        ["elsewhere", "/home/me", "/a/b", true],
        ["a root context", "/anything", "/", false],
        ["no context folder is no bound", "/home/me", "", false],
        ["no workspace folder asks nothing", "", "/a/b", false],
        ["a relative folder cannot be confirmed as inside", "b/c", "/a/b", true],
        ["a windows folder inside", "C:\\Clients\\sefers\\app", "C:\\Clients\\sefers", false],
        ["a windows sibling sharing the prefix", "C:\\Clients\\sefers2", "C:\\Clients\\sefers", true],
        ["a windows parent step", "C:\\Clients\\sefers\\..\\other", "C:\\Clients\\sefers", true],
    ];
    for (const [name, folder, contextFolder, want] of cases) {
        it(name, () => {
            expect(isOutsideContextFolder(folder, contextFolder)).toBe(want);
        });
    }
});
