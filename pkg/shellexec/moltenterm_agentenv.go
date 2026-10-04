// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"os"
	"runtime"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
	"github.com/wavetermdev/waveterm/pkg/util/envutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// localShellBaseEnv is the environment a local shell starts from: wavesrv's own, without the session markers of an
// agent that launched MoltenTerm (#106), and with the Claude Code slots of the mods (FR-MORPH-010).
func localShellBaseEnv() []string {
	env := envutil.StripAgentSessionMarkers(os.Environ())
	value, set := moltenAgentPartsEnv()
	if !set {
		return env
	}
	kept := make([]string, 0, len(env)+1)
	prefix := agentparts.PluginDirsVarName + "="
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			continue
		}
		kept = append(kept, kv)
	}
	if value == "" {
		return kept
	}
	return append(kept, prefix+value)
}

// moltenAgentPartsEnv is CLAUDE_CODE_PLUGIN_DIRS for a local shell. set is false when the shell can keep the
// inherited value as it is (nothing inherited and no slot); an empty value with set means "unset it", for a value
// holding only the slots of a MoltenTerm that started this one.
func moltenAgentPartsEnv() (string, bool) {
	inherited := os.Getenv(agentparts.PluginDirsVarName)
	safeMode := os.Getenv(agentparts.SafeModeVarName) == "1"
	value := agentparts.PluginDirsValue(inherited, wavebase.GetWaveDataDir(), safeMode, runtime.GOOS)
	return value, value != inherited
}
