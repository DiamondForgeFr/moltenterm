// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { placedFloatingStyles, useFloatingInPlace } from "./floating-in-place";

const floatingCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@floating-ui/react", async (importOriginal) => {
    const real = await importOriginal<typeof import("@floating-ui/react")>();
    return {
        ...real,
        useFloating: (options: Record<string, unknown>) => {
            floatingCalls.push(options);
            return real.useFloating(options);
        },
    };
});

const Root = path.resolve(__dirname, "../..");

function Probe() {
    const { refs, floatingStyles } = useFloatingInPlace({ open: true, strategy: "fixed" });
    return <div ref={refs.setFloating} style={floatingStyles} data-testid="probe" />;
}

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return sourceFiles(full);
        }
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
}

describe("useFloatingInPlace (#1440)", () => {
    it("paints nothing before floating-ui measured the surface, and never through transform", () => {
        floatingCalls.length = 0;
        const html = renderToStaticMarkup(<Probe />);
        expect(html).toContain("visibility:hidden");
        expect(html).not.toMatch(/transform/);
        // floating-ui's default places through `transform`, which an entrance keyframe overrides while it runs.
        expect(floatingCalls).toHaveLength(1);
        expect(floatingCalls[0]).toMatchObject({ transform: false, open: true, strategy: "fixed" });
    });

    it("places through left and top once positioned, so an entrance keyframe on transform cannot move it", () => {
        const style = placedFloatingStyles({ position: "fixed", left: 529, top: 36 }, true);
        expect(style).toEqual({ position: "fixed", left: 529, top: 36, visibility: "visible" });
        expect(placedFloatingStyles({ position: "fixed", left: 0, top: 0 }, false).visibility).toBe("hidden");
    });

    it("is the only way Moltenterm's surfaces and Wave's menus call floating-ui", () => {
        const files = [
            ...sourceFiles(path.join(Root, "frontend/moltenterm-shell")),
            ...["popover.tsx", "flyoutmenu.tsx"].map((f) => path.join(Root, "frontend/app/element", f)),
            path.join(Root, "frontend/app/workspace/widgets.tsx"),
        ];
        const offenders = files
            .filter((f) => !f.endsWith("floating-in-place.ts"))
            .filter((f) => /\buseFloating\(/.test(fs.readFileSync(f, "utf8")))
            .map((f) => path.relative(Root, f));
        expect(offenders).toEqual([]);
    });

    it("starts the command panel's entrance once it stands at its place", () => {
        const css = fs.readFileSync(
            path.join(Root, "frontend/moltenterm-shell/command-panel/command-panel.css"),
            "utf8"
        );
        const animated = [...css.matchAll(/([^{}]+)\{[^}]*animation:\s*molten-cmdpanel-in\b/g)].map((m) => m[1].trim());
        expect(animated.length).toBeGreaterThan(0);
        for (const selector of animated) {
            expect(selector.split("\n").pop()).toBe(".molten-cmdpanel[data-placed]");
        }
    });
});
