// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The channels of Brokk as a kind colleague (FR-BOSS-009, #2221), shared by the preload and Electron main
// (moltenterm-colleague.ts). The windows reach them through emain/preload.ts (moltentermBrokk*): keep the names in step.

// window -> main (invoke): a page starts to listen, with its facts; the answer is the moments as they now are
export const ColleagueStartChannel = "moltenterm-brokk-start";
// window -> main: the page stops listening
export const ColleagueStopChannel = "moltenterm-brokk-stop";
// window -> main: the page's facts changed (the agents at work, the setting)
export const ColleagueFactsChannel = "moltenterm-brokk-facts";
// window -> main: an input of the developer, with the page's facts
export const ColleagueInputChannel = "moltenterm-brokk-input";
// window -> main (sendSync): a moment is on screen; the answer is the moment, or null when another window has it
export const ColleagueShownChannel = "moltenterm-brokk-shown";
// window -> main: the group or the bubble closed on a moment the developer saw
export const ColleagueSeenChannel = "moltenterm-brokk-seen";
// main -> the listening windows: the moments, with their revision
export const ColleagueMomentsChannel = "moltenterm-brokk-moments";
