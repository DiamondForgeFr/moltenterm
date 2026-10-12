// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { applyGoldDirs, lockHolder, moltentermDirSuffix, planGoldDirs } from "./moltenterm-gold-dirs";

const temps: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "molten-gold-dirs-"));
    temps.push(dir);
    return dir;
}

function folder(dir: string, file = "wave.lock"): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), "x");
    return dir;
}

afterEach(() => {
    for (const dir of temps.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("gold folders (#509)", () => {
    it("gives a gold folders of its own, a dev build its dev folders, a release the product's", () => {
        expect(moltentermDirSuffix("gold", false)).toBe("gold");
        expect(moltentermDirSuffix("gold", true)).toBe("dev");
        expect(moltentermDirSuffix("rc", false)).toBe("");
        expect(moltentermDirSuffix("public", false)).toBe("");
        expect(moltentermDirSuffix("local", false)).toBe("");
    });

    it("renames the folders golds shared with releases, keeping what they hold", () => {
        const root = tempDir();
        const data = folder(path.join(root, "data", "moltenterm"), "db.txt");
        const config = folder(path.join(root, "config", "moltenterm"), "settings.json");
        const pairs = [
            { from: data, to: path.join(root, "data", "moltenterm-gold") },
            { from: config, to: path.join(root, "config", "moltenterm-gold") },
        ];
        const plan = planGoldDirs(pairs, data);
        expect(plan.busy).toBeUndefined();
        expect(applyGoldDirs(plan)).toHaveLength(2);
        expect(fs.readFileSync(path.join(root, "data", "moltenterm-gold", "db.txt"), "utf8")).toBe("x");
        expect(fs.existsSync(path.join(root, "config", "moltenterm-gold", "settings.json"))).toBe(true);
        expect(fs.existsSync(data)).toBe(false);
        expect(planGoldDirs(pairs, data).moves).toEqual([]);
    });

    it("never moves onto a gold folder that exists, nor a folder that is missing", () => {
        const root = tempDir();
        const data = folder(path.join(root, "moltenterm"));
        const gold = folder(path.join(root, "moltenterm-gold"));
        expect(planGoldDirs([{ from: data, to: gold }], data).moves).toEqual([]);
        const missing = path.join(root, "nothing");
        expect(planGoldDirs([{ from: missing, to: path.join(root, "x") }], missing).moves).toEqual([]);
    });

    it("refuses to move the folders while a MoltenTerm holds them", () => {
        const root = tempDir();
        const data = folder(path.join(root, "moltenterm"));
        fs.mkdirSync(path.join(data, "electron"));
        fs.symlinkSync(`host.local-${process.pid}`, path.join(data, "electron", "SingletonLock"));
        const plan = planGoldDirs([{ from: data, to: path.join(root, "moltenterm-gold") }], data);
        expect(plan.moves).toEqual([]);
        expect(plan.busy).toContain(`pid ${process.pid}`);
        expect(lockHolder(path.join(data, "electron"), fs, () => false)).toBe(0);
        expect(lockHolder(path.join(root, "none"))).toBe(0);
    });
});
