// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import "errors"

// Moltenterm ships no built-in AI (FR-MORPH-008): the coding agent the user runs in a terminal is the only AI in
// the workspace. Wave's AI code stays in the tree so that upstream merges stay simple, but every chat entry point
// returns ErrMoltentermNoAI before reading its input or reaching a provider.
const MoltentermNoAI = true

var ErrMoltentermNoAI = errors.New("AI chat is not available in Moltenterm: use your own coding agent in a terminal")
