// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The edge of a panel's arrival (FR-SHELL-112, #1349), over the panel's frame (blockframe.tsx) while the model
// (panel-arrival-model.ts) says it arrives; panel-motion.css runs it once around the frame, then puts it out.

import { useAtomValue } from "jotai";
import { PanelArrival } from "./panel-arrival-model";
import "./panel-motion.css";

export function PanelArrivalEdge({ blockId }: { blockId: string }) {
    const model = PanelArrival.getInstance();
    const seq = useAtomValue(model.seqAtom(blockId));
    if (!seq) {
        return null;
    }
    const delay = model.delayMs(blockId);
    return (
        <div
            key={seq}
            className="mt-panel-arrival"
            data-testid="panel-arrival"
            aria-hidden
            style={delay > 0 ? ({ "--mt-arrival-delay": `${delay}ms` } as React.CSSProperties) : undefined}
            onAnimationEnd={(e) => {
                if (e.target === e.currentTarget) {
                    model.done(blockId, seq);
                }
            }}
        >
            <span />
        </div>
    );
}
