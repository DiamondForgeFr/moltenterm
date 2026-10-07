// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// MoltenCommandName is the name `molten` is installed under next to wsh (DS-MORPH-004). wsh recognises it and runs its
// molten command group (cmd/wsh/cmd/wshcmd-molten.go).
const MoltenCommandName = "molten"

// MoltenOpenCommandName is the BROWSER handler of local terminals (FR-BRW-007, DS-BRW-008), installed next to molten.
// wsh recognises it and runs `molten open --from-browser-env` (cmd/wsh/cmd/wshcmd-molten-browserenv.go).
const MoltenOpenCommandName = "molten-open"

// BrowserVarName is the variable programs read to open a web page (gh, npm, Python's webbrowser, xdg-open...).
const BrowserVarName = "BROWSER"

// AgentBinDirName is the folder of the agent launchers (FR-SHELL-036, DS-SHELL-044), under the wsh bin folder: the
// shell integration scripts put it first on PATH after the user's startup files, so `claude` runs the launcher.
const AgentBinDirName = "agents"

// AgentLauncherNames are the agents started through a launcher; must match pkg/molten/agentlaunch's adapters
// (checked by its tests).
var AgentLauncherNames = []string{"claude", "codex"}

// InstallMoltenCommand makes `molten` and `molten-open` available wherever wsh is: a relative symlink to wsh, so that
// they follow every wsh update, or a copy on Windows, where symlinks need extra rights. The agent launchers go in
// their own folder (agents/claude -> ../wsh), which only local shells put on PATH.
func InstallMoltenCommand(binDir string, wshPath string) error {
	for _, name := range []string{MoltenCommandName, MoltenOpenCommandName} {
		if err := installWshAlias(binDir, wshPath, name, filepath.Base(wshPath)); err != nil {
			return err
		}
	}
	agentDir := filepath.Join(binDir, AgentBinDirName)
	if err := os.MkdirAll(agentDir, 0755); err != nil {
		return fmt.Errorf("creating %s: %w", agentDir, err)
	}
	for _, name := range AgentLauncherNames {
		if err := installWshAlias(agentDir, wshPath, name, filepath.Join("..", filepath.Base(wshPath))); err != nil {
			return err
		}
	}
	return nil
}

func installWshAlias(binDir string, wshPath string, name string, target string) error {
	if runtime.GOOS == "windows" {
		return utilfn.AtomicRenameCopy(filepath.Join(binDir, name+".exe"), wshPath, 0755)
	}
	aliasPath := filepath.Join(binDir, name)
	if current, err := os.Readlink(aliasPath); err == nil && current == target {
		return nil
	}
	err := os.Remove(aliasPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("replacing %s: %w", aliasPath, err)
	}
	err = os.Symlink(target, aliasPath)
	if err != nil {
		return fmt.Errorf("linking %s to %s: %w", aliasPath, target, err)
	}
	return nil
}

// MoltenOpenPath is the absolute path of molten-open in the local wsh bin dir, or "" when it is not installed: a
// BROWSER naming a missing file would make every program that opens a link fail.
func MoltenOpenPath() string {
	name := MoltenOpenCommandName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(wavebase.GetWaveDataDir(), WaveHomeBinDir, name)
	if _, err := os.Stat(path); err != nil {
		return ""
	}
	return path
}
