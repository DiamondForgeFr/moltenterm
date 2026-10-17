// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The 360 view's icon (#824): a solid fixed first column, then an outlined panel above a two-way arrow, the carpet
// that scrolls sideways. Two equal bars read as a video pause button, so the column is solid and narrower than the
// panel, and the arrow carries the movement.
export function CarpetIcon() {
    return (
        <svg className="mt-v360-icon" width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
            <rect data-part="fixed" x="0.5" y="0.5" width="3" height="11" rx="1" fill="currentColor" />
            <g fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                <rect data-part="panel" x="6.125" y="0.625" width="7.25" height="6" rx="1" />
                <path data-part="scroll" d="M6.5 10H13.5M8 8.5 6.5 10 8 11.5M12 8.5 13.5 10 12 11.5" />
            </g>
        </svg>
    );
}
