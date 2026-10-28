// MOLTENTERM-PATCH (#820): validate this checkout, not checkouts stored beneath it.
import { UserConfig, configDefaults, defineConfig, mergeConfig } from "vitest/config";
import electronViteConfig from "./electron.vite.config";

export default mergeConfig(
    electronViteConfig.renderer as UserConfig,
    defineConfig({
        test: {
            exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
            // MOLTENTERM-PATCH (#1213): the shipped dictionaries, loaded up front as in Electron main
            setupFiles: ["frontend/moltenterm-shell/i18n/i18n-test-setup.ts"],
            reporters: ["verbose", "junit"],
            outputFile: {
                junit: "test-results.xml",
            },
            coverage: {
                provider: "istanbul",
                reporter: ["lcov"],
                reportsDirectory: "./coverage",
            },
            typecheck: {
                tsconfig: "tsconfig.json",
            },
        },
    })
);
