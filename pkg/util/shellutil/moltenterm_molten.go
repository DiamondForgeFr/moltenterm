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
)

// MoltenCommandName is the name `molten` is installed under next to wsh (DS-MORPH-004). wsh recognises it and runs its
// molten command group (cmd/wsh/cmd/wshcmd-molten.go).
const MoltenCommandName = "molten"

// InstallMoltenCommand makes `molten` available wherever wsh is: a relative symlink to wsh, so that it follows every
// wsh update, or a copy on Windows, where symlinks need extra rights.
func InstallMoltenCommand(binDir string, wshPath string) error {
	if runtime.GOOS == "windows" {
		return utilfn.AtomicRenameCopy(filepath.Join(binDir, MoltenCommandName+".exe"), wshPath, 0755)
	}
	moltenPath := filepath.Join(binDir, MoltenCommandName)
	target := filepath.Base(wshPath)
	if current, err := os.Readlink(moltenPath); err == nil && current == target {
		return nil
	}
	err := os.Remove(moltenPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("replacing %s: %w", moltenPath, err)
	}
	err = os.Symlink(target, moltenPath)
	if err != nil {
		return fmt.Errorf("linking %s to %s: %w", moltenPath, target, err)
	}
	return nil
}
