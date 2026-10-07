// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"os"
	"runtime"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
	"github.com/wavetermdev/waveterm/pkg/util/envutil"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// localShellBaseEnv is the environment a local shell starts from: wavesrv's own, without the session markers of an
// agent that launched MoltenTerm (#106), with the Claude Code slots of the mods (FR-MORPH-010) and with BROWSER
// pointing to molten-open (FR-BRW-007).
func localShellBaseEnv() []string {
	env := envutil.StripAgentSessionMarkers(os.Environ())
	if value, set := moltenAgentPartsEnv(); set {
		env = replaceEnvVar(env, agentparts.PluginDirsVarName, value)
	}
	if value := moltenBrowserEnv(); value != "" {
		env = replaceEnvVar(env, shellutil.BrowserVarName, value)
	}
	return env
}

// replaceEnvVar drops every inherited entry of name, then sets it to value; an empty value leaves it unset.
func replaceEnvVar(env []string, name string, value string) []string {
	kept := make([]string, 0, len(env)+1)
	prefix := name + "="
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

// moltenBrowserEnv is BROWSER for a local shell: molten-open's absolute path, or "" when it is not installed (the
// inherited value is then kept). It is set in the shell's process environment, not in the swap token: every shell
// startup file (~/.zshenv, ~/.zshrc, ~/.bash_profile, config.fish, which fish reads before the token) and the block's
// cmd:env (applied through the token) run after it, so a value the user sets there wins.
func moltenBrowserEnv() string {
	return shellutil.MoltenOpenPath()
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
