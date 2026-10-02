// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    linkUpdate,
    logoProbeOrder,
    logoUrl,
    pathBaseName,
    pathParent,
    projectFilePath,
    ProjectLogoMetaKey,
    ProjectLogoOfferMetaKey,
    ProjectMetaKey,
    readmeFirstImage,
    readWorkspaceProject,
    shouldOfferLogo,
    unlinkUpdate,
} from "./workspace-project";

function ws(meta: Record<string, any>): Workspace {
    return { oid: "w", meta, tabids: [], activetabid: "", otype: "workspace", version: 1 } as Workspace;
}

describe("readWorkspaceProject", () => {
    it("reads the link and the logo from the workspace meta", () => {
        expect(readWorkspaceProject(ws({ [ProjectMetaKey]: "/p", [ProjectLogoMetaKey]: "/p/icon.png" }))).toEqual({
            dir: "/p",
            logo: "/p/icon.png",
            logoOffer: "",
        });
        expect(readWorkspaceProject(ws(null))).toEqual({ dir: "", logo: "", logoOffer: "" });
        expect(readWorkspaceProject(ws({ [ProjectMetaKey]: 42 })).dir).toBe("");
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
        expect(linkUpdate(current, "/b")).toEqual({ [ProjectMetaKey]: "/b", [ProjectLogoMetaKey]: null });
        expect(unlinkUpdate()).toEqual({
            [ProjectMetaKey]: null,
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
