// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applyAppTheme, LightThemeClass, resolveAppTheme, SuiteLightClass, themeSetting } from "./app-theme";

function fakeRoot() {
    const classes = new Set<string>();
    return {
        classes,
        root: {
            classList: {
                toggle: (name: string, on: boolean) => {
                    if (on) {
                        classes.add(name);
                    } else {
                        classes.delete(name);
                    }
                    return on;
                },
            },
            dataset: {} as Record<string, string>,
        } as unknown as HTMLElement,
    };
}

// FR-SHELL-121: Dark stays the default, Light is opt-in, Same as the system follows the system.
describe("interface theme (FR-SHELL-121)", () => {
    it.each([undefined, null, "", "dark", "sepia", 1, true])("reads %s as dark", (value) => {
        expect(themeSetting(value)).toBe("dark");
        expect(resolveAppTheme(value, false)).toBe("dark");
    });

    it("stays light when the setting says light, whatever the system", () => {
        expect(resolveAppTheme("light", true)).toBe("light");
        expect(resolveAppTheme("light", false)).toBe("light");
    });

    it("follows the system with Same as the system (AC-1)", () => {
        expect(resolveAppTheme("system", true)).toBe("dark");
        expect(resolveAppTheme("system", false)).toBe("light");
    });

    it("puts the light classes on the root in light, and takes them off in dark", () => {
        const { classes, root } = fakeRoot();
        applyAppTheme(root, "light");
        expect([...classes].sort()).toEqual([SuiteLightClass, LightThemeClass].sort());
        expect(root.dataset.mtTheme).toBe("light");
        applyAppTheme(root, "dark");
        expect(classes.size).toBe(0);
        expect(root.dataset.mtTheme).toBe("dark");
    });
});
