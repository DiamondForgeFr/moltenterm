// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = readdirSync("emain", { recursive: true }).map(String)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({ file, source: readFileSync(`emain/${file}`, "utf8") }));
const constants = new Map<string, string>();
for (const source of [
    ...files.map((entry) => entry.source),
    readFileSync("frontend/util/moltenterm-gold.ts", "utf8"),
    readFileSync("frontend/util/moltenterm-dialogs.ts", "utf8"),
    readFileSync("frontend/moltenterm-shell/update/release-feed.ts", "utf8"),
]) {
    for (const match of source.matchAll(/const\s+(\w+Channel)\s*=\s*"([^"]+)"/g)) constants.set(match[1], match[2]);
}
const documentation = readFileSync("docs/privileged-ipc.md", "utf8");

describe("privileged IPC inventory", () => {
    it("keeps direct Electron IPC access inside the authorization helper", () => {
        for (const { file, source } of files) {
            if (file === "moltenterm-privileged-ipc.ts") continue;
            expect(source, file).not.toMatch(/\bipcMain\b/);
        }
    });

    it("documents every registered channel and permits only the three guest exceptions", () => {
        const guests: string[] = [];
        const dynamics: string[] = [];
        let count = 0;
        for (const { file, source } of files) {
            for (const match of source.matchAll(/\b(onAppIpc|handleAppIpc|onGuestIpc)\(\s*("[^"]+"|\w+)/g)) {
                count++;
                const channel = match[2].startsWith('"') ? JSON.parse(match[2]) : constants.get(match[2]);
                if (!channel) {
                    dynamics.push(`${file}:${match[2]}`);
                    continue;
                }
                expect(documentation, `${file}: ${channel}`).toContain(`\`${channel}\``);
                if (match[1] === "onGuestIpc") guests.push(channel);
            }
        }
        expect(count).toBeGreaterThan(70);
        expect(dynamics).toEqual(["emain-web.ts:respCh"]);
        expect(guests.sort()).toEqual([
            "moltenterm-contextmenu-guest-request",
            "moltenterm-webview-input",
            "webview-mouse-navigate",
        ]);
    });
});
