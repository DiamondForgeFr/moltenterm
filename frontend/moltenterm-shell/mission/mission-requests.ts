// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export type MissionRequest = { sequence: number; revision: number };

// One instance belongs to one effect lifetime, including React's setup/cleanup replay.
export class MissionRequests {
    active = true;
    sequence = 0;
    revision = 0;

    begin(): MissionRequest {
        if (!this.active) {
            return null;
        }
        return { sequence: ++this.sequence, revision: this.revision };
    }

    accepts(request: MissionRequest, unchanged = false): boolean {
        return (
            this.active &&
            request != null &&
            request.sequence === this.sequence &&
            (!unchanged || request.revision === this.revision)
        );
    }

    hear(): boolean {
        if (!this.active) {
            return false;
        }
        this.revision++;
        return true;
    }

    dispose(): void {
        this.active = false;
    }
}
