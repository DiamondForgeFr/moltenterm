// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    checkStoredIconName,
    hasImportedIcon,
    iconKindLabel,
    resolveWorkspaceIcon,
    storedIconPath,
    WorkspaceIconMetaKey,
    workspaceIconSource,
} from "./workspace-icon-model";
import { ProjectLogoMetaKey } from "./workspace-project";

const DataDir = "/Users/a/Library/Application Support/moltenterm";
const Image = "6b0f6a0e-2b6f-4b8e-9a37-1c1d2f3e4a5b-0123456789ab.png";
const ImagePath = `${DataDir}/workspace-icons/${Image}`;

function ws(meta: Record<string, any>): Workspace {
    return { oid: "w1", name: "Client", icon: "rocket", color: "#429DFF", meta } as unknown as Workspace;
}

describe("resolveWorkspaceIcon (DS-SHELL-037)", () => {
    it("puts the imported image first, then the project logo, then the built-in icon and colour", () => {
        const both = workspaceIconSource(ws({ [WorkspaceIconMetaKey]: Image, [ProjectLogoMetaKey]: "/p/logo.svg" }));
        expect(resolveWorkspaceIcon(both, DataDir)).toEqual({
            kind: "imported",
            path: ImagePath,
            icon: "rocket",
            color: "#429DFF",
        });
        const logo = workspaceIconSource(ws({ [ProjectLogoMetaKey]: "/p/logo.svg" }));
        expect(resolveWorkspaceIcon(logo, DataDir)).toMatchObject({ kind: "logo", path: "/p/logo.svg" });
        expect(resolveWorkspaceIcon(workspaceIconSource(ws({})), DataDir)).toEqual({
            kind: "builtin",
            path: "",
            icon: "rocket",
            color: "#429DFF",
        });
    });

    it("steps down one level for each image that failed to display (AC9)", () => {
        const both = workspaceIconSource(ws({ [WorkspaceIconMetaKey]: Image, [ProjectLogoMetaKey]: "/p/logo.svg" }));
        expect(resolveWorkspaceIcon(both, DataDir, [ImagePath])).toMatchObject({ kind: "logo", path: "/p/logo.svg" });
        expect(resolveWorkspaceIcon(both, DataDir, [ImagePath, "/p/logo.svg"])).toMatchObject({
            kind: "builtin",
            icon: "rocket",
        });
        const imageOnly = workspaceIconSource(ws({ [WorkspaceIconMetaKey]: Image }));
        expect(resolveWorkspaceIcon(imageOnly, DataDir, [ImagePath]).kind).toBe("builtin");
    });

    it("never turns a meta value into another file", () => {
        for (const bad of ["/etc/passwd", "../../x-0123456789ab.png", "x-0123456789ab.gif", "x.png", 12, null]) {
            const source = workspaceIconSource(ws({ [WorkspaceIconMetaKey]: bad }));
            expect(resolveWorkspaceIcon(source, DataDir).kind).toBe("builtin");
        }
        expect(checkStoredIconName(Image)).toBe(true);
        expect(checkStoredIconName("w1-0123456789ab.svg")).toBe(true);
        expect(checkStoredIconName("w1-0123456789AB.svg")).toBe(false);
    });

    it("falls back without a data folder, and joins Windows paths with their separator", () => {
        const source = workspaceIconSource(ws({ [WorkspaceIconMetaKey]: Image }));
        expect(resolveWorkspaceIcon(source, "").kind).toBe("builtin");
        expect(storedIconPath("C:\\Users\\a\\moltenterm\\", Image)).toBe(
            `C:\\Users\\a\\moltenterm\\workspace-icons\\${Image}`
        );
        expect(storedIconPath(DataDir + "/", Image)).toBe(ImagePath);
    });

    it("reads a missing workspace as a blank built-in icon", () => {
        expect(resolveWorkspaceIcon(workspaceIconSource(null), DataDir)).toEqual({
            kind: "builtin",
            path: "",
            icon: "",
            color: "",
        });
        expect(hasImportedIcon(null)).toBe(false);
    });
});

describe("helpers", () => {
    it("knows whether the workspace carries an imported image", () => {
        expect(hasImportedIcon(ws({ [WorkspaceIconMetaKey]: Image }))).toBe(true);
        expect(hasImportedIcon(ws({ [WorkspaceIconMetaKey]: "" }))).toBe(false);
        expect(hasImportedIcon(ws({ [ProjectLogoMetaKey]: "/p/logo.svg" }))).toBe(false);
    });

    it("names the kind for screen readers", () => {
        expect(iconKindLabel("imported")).toBe("imported image");
        expect(iconKindLabel("logo")).toBe("project logo");
        expect(iconKindLabel("builtin")).toBe("");
    });
});
