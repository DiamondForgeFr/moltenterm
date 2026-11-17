// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The logs in Electron main (FR-PERF-016, #2335): the size and the clear Settings asks for, and the one window told when
// the logs grow past the high mark. The file that rotates is emain-log.ts's (moltenterm-log-files.ts); the window
// never names a path, and Show in folder is the hang report's channel.

import * as electron from "electron";
import { log, logFiles } from "./emain-log";
import { getWaveDataDir } from "./emain-platform";
import { readLogsInfo } from "./moltenterm-log-files";
import { LogsClearChannel, LogsHighChannel, LogsInfoChannel, LogsListenChannel } from "./moltenterm-logs-ipc";
import { LogsListener, makeLogsService } from "./moltenterm-logs-service";
import { handleAppIpc } from "./moltenterm-privileged-ipc";

function listenerOf(contents: electron.WebContents): LogsListener {
    return {
        id: contents.id,
        alive: () => !contents.isDestroyed(),
        send: (edge) => contents.send(LogsHighChannel, edge),
    };
}

export function initMoltentermLogs(): void {
    if (logFiles == null) {
        return;
    }
    const dataDir = getWaveDataDir();
    const service = makeLogsService({ files: logFiles, read: () => readLogsInfo(dataDir), log });
    logFiles.setHooks({
        onMaintained: (info) => service.note(info),
        onError: (message, error) => log(`${message}:`, error),
    });
    handleAppIpc(LogsInfoChannel, () => service.info());
    handleAppIpc(LogsClearChannel, () => service.clear());
    handleAppIpc(LogsListenChannel, (event) => service.listen(listenerOf(event.sender)));
    // The cap applies to what a launch left, and the first reading tells the windows.
    void logFiles.maintain();
}
