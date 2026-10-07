// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// What a launch writes lives in <data>/molten/agent-launch/, owner-only (NFR-SHELL-021): commands only, named by
// their content, so a run reuses the file of the previous one while nothing changed. A file unused for a week goes.

const (
	launchFileMaxAge = 7 * 24 * time.Hour
	launchDirMode    = 0700
	launchFileMode   = 0600
	launchFileExt    = ".json"
	launchTempPrefix = ".tmp-"
)

// LaunchDir is the folder of the generated files.
func LaunchDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "agent-launch")
}

// LaunchFileName is the content-addressed name of a generated file.
func LaunchFileName(prefix string, data []byte) string {
	sum := sha256.Sum256(data)
	return prefix + "-" + hex.EncodeToString(sum[:16]) + launchFileExt
}

// WriteLaunchFile writes data under its content-addressed name, or marks the existing file as used.
func WriteLaunchFile(dir string, prefix string, data []byte, now time.Time) (string, error) {
	if err := os.MkdirAll(dir, launchDirMode); err != nil {
		return "", err
	}
	if info, err := os.Stat(dir); err == nil && info.Mode().Perm() != launchDirMode {
		os.Chmod(dir, launchDirMode)
	}
	path := filepath.Join(dir, LaunchFileName(prefix, data))
	if existing, err := os.ReadFile(path); err == nil && string(existing) == string(data) {
		os.Chtimes(path, now, now)
		return path, nil
	}
	tmp, err := os.CreateTemp(dir, launchTempPrefix+prefix+"-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmpPath, launchFileMode)
	}
	if werr == nil {
		werr = os.Rename(tmpPath, path)
	}
	if werr != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("writing %s: %w", path, werr)
	}
	return path, nil
}

// SweepLaunchFiles removes the generated files (and stray temporary files) unused for a week. A running agent
// read its file at start, so a file going under it is harmless.
func SweepLaunchFiles(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !(strings.HasSuffix(name, launchFileExt) || strings.HasPrefix(name, launchTempPrefix)) {
			continue
		}
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < launchFileMaxAge {
			continue
		}
		os.Remove(filepath.Join(dir, name))
	}
}
