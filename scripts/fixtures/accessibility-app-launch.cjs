// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const { app } = require("electron");
if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.setAppPath(process.cwd());
import("../../dist/main/index.js");
