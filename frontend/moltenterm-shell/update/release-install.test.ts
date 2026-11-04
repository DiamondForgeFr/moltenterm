// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import pkg from "../../../package.json";
import {
    holdsTheOffer,
    installPlanOf,
    parseChecksums,
    parseReleaseSwapStatus,
    releaseDownloadOverride,
    releaseFileName,
    releaseFileUrl,
    ReleaseInstallState,
    ReleasePackageName,
    ReleaseProductName,
    upgradedFrom,
} from "./release-install";

describe("the names the release workflow gives its files", () => {
    it("agree with package.json and with scripts/release-inventory.mjs", () => {
        expect(ReleaseProductName).toBe(pkg.productName);
        expect(ReleasePackageName).toBe(pkg.name);
        // The files of v1.0.0-8, as listed on its release page.
        expect(releaseFileName("zip", "darwin", "arm64", "1.0.0-8")).toBe("MoltenTerm-darwin-arm64-1.0.0-8.zip");
        expect(releaseFileName("zip", "darwin", "x64", "1.0.0-8")).toBe("MoltenTerm-darwin-x64-1.0.0-8.zip");
        expect(releaseFileName("dmg", "darwin", "arm64", "1.0.0-8")).toBe("MoltenTerm-darwin-arm64-1.0.0-8.dmg");
        expect(releaseFileName("AppImage", "linux", "x64", "1.0.0-8")).toBe("moltenterm-linux-x86_64-1.0.0-8.AppImage");
        expect(releaseFileName("AppImage", "linux", "arm64", "1.0.0-8")).toBe(
            "moltenterm-linux-arm64-1.0.0-8.AppImage"
        );
        expect(releaseFileName("deb", "linux", "x64", "1.0.0")).toBe("moltenterm-linux-amd64-1.0.0.deb");
        expect(releaseFileName("deb", "linux", "arm64", "1.0.0")).toBe("moltenterm-linux-arm64-1.0.0.deb");
    });

    it("names nothing for a platform, an architecture, a kind or a version no build is published for", () => {
        expect(releaseFileName("zip", "win32", "x64", "1.0.0")).toBeNull();
        expect(releaseFileName("zip", "darwin", "ia32", "1.0.0")).toBeNull();
        expect(releaseFileName("AppImage", "darwin", "arm64", "1.0.0")).toBeNull();
        expect(releaseFileName("zip", "darwin", "arm64", "1.0")).toBeNull();
        expect(releaseFileName("zip", "darwin", "arm64", "1.0.0/../x")).toBeNull();
        expect(releaseFileName("zip", "darwin", "arm64", undefined)).toBeNull();
    });
});

describe("where the files come from", () => {
    const github = "https://github.com/DiamondForgeFr/moltenterm/releases/download";

    it("builds each address from the tag and the file name, on this repository's releases", () => {
        expect(releaseFileUrl("v1.0.0-8", "SHA256SUMS.txt")).toBe(`${github}/v1.0.0-8/SHA256SUMS.txt`);
        expect(releaseFileUrl("v1.0.0", "MoltenTerm-darwin-arm64-1.0.0.zip")).toBe(
            `${github}/v1.0.0/MoltenTerm-darwin-arm64-1.0.0.zip`
        );
    });

    it("refuses a tag or a name that could point anywhere else", () => {
        for (const tag of ["1.0.0", "v1.0", "v1.0.0-0", "v1.0.0/../../x", "v1.0.0?x=1", "", undefined]) {
            expect(releaseFileUrl(tag, "SHA256SUMS.txt"), String(tag)).toBeNull();
        }
        for (const name of ["../x", "a/b", "a b", ".hidden", "x?y", "", undefined]) {
            expect(releaseFileUrl("v1.0.0", name), String(name)).toBeNull();
        }
    });

    it("serves a test instance from this machine only, and never a build that is not one", () => {
        const env = { MOLTENTERM_BACKGROUND: "1", MOLTENTERM_RELEASE_DOWNLOAD_URL: "http://127.0.0.1:4567/files/" };
        expect(releaseDownloadOverride(env)).toBe("http://127.0.0.1:4567/files");
        expect(releaseFileUrl("v1.0.0-9", "SHA256SUMS.txt", env)).toBe(
            "http://127.0.0.1:4567/files/v1.0.0-9/SHA256SUMS.txt"
        );
        expect(releaseDownloadOverride({ ...env, MOLTENTERM_BACKGROUND: undefined })).toBeNull();
        expect(
            releaseDownloadOverride({ ...env, MOLTENTERM_RELEASE_DOWNLOAD_URL: "http://evil.example/x" })
        ).toBeNull();
        expect(releaseDownloadOverride({ ...env, MOLTENTERM_RELEASE_DOWNLOAD_URL: "https://127.0.0.1/x" })).toBeNull();
        expect(releaseDownloadOverride({ ...env, MOLTENTERM_RELEASE_DOWNLOAD_URL: "not a url" })).toBeNull();
        expect(
            releaseFileUrl("v1.0.0-9", "SHA256SUMS.txt", {
                MOLTENTERM_RELEASE_DOWNLOAD_URL: env.MOLTENTERM_RELEASE_DOWNLOAD_URL,
            })
        ).toBe(`${github}/v1.0.0-9/SHA256SUMS.txt`);
    });
});

describe("what the app can do for this install", () => {
    const mac = { platform: "darwin", arch: "arm64", packaged: true };
    const linux = { platform: "linux", arch: "x64", packaged: true };

    it("replaces a macOS bundle it can write, and downloads the disk image otherwise", () => {
        expect(installPlanOf({ ...mac, bundle: "/Applications/MoltenTerm.app", writable: true })).toEqual({
            mode: "swap",
            kind: "zip",
        });
        expect(installPlanOf({ ...mac, bundle: "/Applications/MoltenTerm.app", writable: false })).toEqual({
            mode: "download",
            reason: "readonly",
            kind: "dmg",
        });
        expect(
            installPlanOf({
                ...mac,
                bundle: "/private/var/folders/x/AppTranslocation/ABC/d/MoltenTerm.app",
                writable: true,
            })
        ).toEqual({ mode: "download", reason: "translocated", kind: "dmg" });
        expect(installPlanOf({ ...mac })).toEqual({ mode: "download", reason: "readonly", kind: "dmg" });
    });

    it("replaces an AppImage it can write, and downloads a package for the others", () => {
        expect(installPlanOf({ ...linux, appImage: "/home/u/MoltenTerm.AppImage", writable: true })).toEqual({
            mode: "swap",
            kind: "AppImage",
        });
        expect(installPlanOf({ ...linux, appImage: "/opt/MoltenTerm.AppImage", writable: false })).toEqual({
            mode: "download",
            reason: "readonly",
            kind: "AppImage",
        });
        expect(installPlanOf({ ...linux, dpkg: true })).toEqual({ mode: "download", reason: "package", kind: "deb" });
        expect(installPlanOf({ ...linux, dpkg: false })).toEqual({
            mode: "download",
            reason: "package",
            kind: "AppImage",
        });
    });

    it("does nothing for an unpackaged build, an unknown architecture or a platform with no published build", () => {
        expect(installPlanOf({ ...mac, packaged: false, bundle: "/x.app", writable: true })).toEqual({
            mode: "none",
            reason: "dev",
        });
        expect(installPlanOf({ ...mac, arch: "ia32", bundle: "/x.app", writable: true })).toEqual({
            mode: "none",
            reason: "platform",
        });
        expect(installPlanOf({ platform: "win32", arch: "x64", packaged: true })).toEqual({
            mode: "none",
            reason: "platform",
        });
        expect(installPlanOf({ ...linux, arch: "ia32" })).toEqual({ mode: "none", reason: "platform" });
    });
});

describe("the checksum list", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);

    it("reads what sha256sum writes, in text or binary mode", () => {
        const list = parseChecksums(`${a}  one.zip\n${b} *two.AppImage\n`);
        expect(list.get("one.zip")).toBe(a);
        expect(list.get("two.AppImage")).toBe(b);
        expect(parseChecksums(`${a}  one.zip\r\n`).get("one.zip")).toBe(a);
    });

    it("trusts nothing but exactly that", () => {
        for (const text of [
            "",
            "\n",
            `${a}  one.zip\n${b}  one.zip\n`,
            `${a.toUpperCase()}  one.zip\n`,
            `${a.slice(1)}  one.zip\n`,
            `${a}  dir/one.zip\n`,
            `${a}  ../one.zip\n`,
            `${a}  one.zip\nanything else\n`,
            `${a}\tone.zip\n`,
        ]) {
            expect(parseChecksums(text), JSON.stringify(text)).toBeNull();
        }
    });
});

describe("the outcome of the last swap", () => {
    it("reads what the swap scripts write", () => {
        expect(parseReleaseSwapStatus("installed 1.0.0-9\n")).toEqual({
            state: "installed",
            version: "1.0.0-9",
            unchecked: false,
        });
        expect(parseReleaseSwapStatus("installed 1.0.0-9 unchecked")).toEqual({
            state: "installed",
            version: "1.0.0-9",
            unchecked: true,
        });
        expect(parseReleaseSwapStatus("rolledback 1.0.0-9")).toEqual({
            state: "rolledback",
            version: "1.0.0-9",
            unchecked: false,
        });
        expect(parseReleaseSwapStatus("failed: the installed app could not be moved aside")).toEqual({
            state: "failed",
            detail: "the installed app could not be moved aside",
        });
        expect(parseReleaseSwapStatus("")).toBeNull();
        expect(parseReleaseSwapStatus("whatever")).toBeNull();
    });
});

describe("upgradedFrom", () => {
    it("tells an update was installed when the version running is later than the last that ran", () => {
        expect(upgradedFrom("1.0.0-8", "1.0.0-9")).toBe(true);
        expect(upgradedFrom("1.0.0-9", "1.0.0")).toBe(true);
        expect(upgradedFrom("1.0.0", "1.0.1-1")).toBe(true);
    });

    it("says nothing on a first run, the same version, a downgrade or a version it cannot read", () => {
        expect(upgradedFrom("", "1.0.0-9")).toBe(false);
        expect(upgradedFrom(undefined, "1.0.0-9")).toBe(false);
        expect(upgradedFrom("1.0.0-9", "1.0.0-9")).toBe(false);
        expect(upgradedFrom("1.0.0-9", "1.0.0-8")).toBe(false);
        expect(upgradedFrom("1.0.1", "1.0.0")).toBe(false);
        expect(upgradedFrom("1.0.0-8", "1.0.0-rc.9")).toBe(false);
        expect(upgradedFrom("x", "1.0.0")).toBe(false);
    });
});

describe("holdsTheOffer", () => {
    it("holds the row while a download runs or an update is staged, not when idle or failed", () => {
        const at = (phase: ReleaseInstallState["phase"]) => holdsTheOffer({ phase });
        expect(at("downloading")).toBe(true);
        expect(at("verifying")).toBe(true);
        expect(at("ready")).toBe(true);
        expect(at("idle")).toBe(false);
        expect(at("error")).toBe(false);
    });
});
