// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

/* global process */
import { spawn } from "node:child_process";
import path from "node:path";
import { build } from "vite";
import { Instance, installCleanupHandlers } from "./perf/lib/instance.mjs";

const root = process.cwd();
installCleanupHandlers();
const instance = Instance.create(root);
try {
  // A file bundle keeps the fixture independent of available localhost ports and the user's running app.
  await build({
    configFile: path.join(root, "frontend/preview/vite.config.ts"),
    root,
    base: "./",
    logLevel: "warn",
    build: {
      outDir: path.join(instance.root, "fixture"),
      rollupOptions: { input: path.join(root, "scripts/settings-slider-fixture.html") },
    },
  });
  instance.child = spawn(
    instance.electronBinary(),
    ["scripts/settings-slider-fixture-electron.cjs", `--user-data-dir=${instance.root}/electron`],
    {
      cwd: root,
      env: {
        ...process.env,
        MOLTENTERM_BACKGROUND: "1",
        MOLTENTERM_SLIDER_FIXTURE_FILE: path.join(instance.root, "fixture/scripts/settings-slider-fixture.html"),
        MOLTENTERM_DATA_HOME: instance.dataDir,
        MOLTENTERM_CONFIG_HOME: instance.configDir,
      },
      stdio: ["ignore", "inherit", "inherit"],
    }
  );
  instance.pid = instance.child.pid;
  const code = await new Promise((resolve, reject) => {
    instance.child.once("error", reject);
    instance.child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Settings browser fixture exited with ${code}`);
} finally {
  await instance.dispose();
}
