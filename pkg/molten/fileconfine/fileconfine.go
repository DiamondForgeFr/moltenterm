// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package fileconfine keeps a workspace's file panels inside its project folder (FR-FILE-001, DS-FILE-001). It is a
// guardrail on what a panel shows, not a sandbox: the panel's model asks before it shows a path outside the project,
// and one approval lets it go anywhere until it comes back inside.
//
// Who decides: the file panel's model in the window (frontend/moltenterm-shell/file-confine/) gates every new file
// meta of the panel, whoever wrote it, because the window is the only thing that shows the panel's content. What
// wavesrv owns: resolving paths (symbolic links, a target that does not exist yet) through the route below, and the
// two meta facts a window must be able to trust. Only a window writes the approval, so an agent cannot approve its own
// request with `wsh setmeta`; and wavesrv stamps who asked on every file meta written from outside the windows, so a
// terminal cannot pass its request off as the user's.
package fileconfine

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	// ApprovedMetaKey holds the project root a panel was approved to leave; it is valid only while the workspace is
	// linked to that root, and ends when the panel shows something inside the project again. Written by windows only.
	ApprovedMetaKey = "molten:fileapproved"
	// OriginMetaKey says who wrote the panel's file meta when it was not a window: OriginAgent or OriginCommand.
	// Absent when the user moved the panel. Written by wavesrv only.
	OriginMetaKey = "molten:fileorigin"
	// OriginNameMetaKey is the first name of the agent that wrote the file meta (FR-CONT-014).
	OriginNameMetaKey = "molten:fileoriginname"

	OriginAgent   = "agent"
	OriginCommand = "command"

	RouteId      = "molten:fileconfine"
	CheckCommand = "moltenfilecheck"
)

// CheckRequest: a path a file panel is about to show, and the project root of its workspace.
type CheckRequest struct {
	Path    string `json:"path"`
	Project string `json:"project"`
}

// CheckResult: whether Path lies inside Project once both are resolved. Path and Project are the resolved paths ("" when
// they could not be resolved); Error says why a path could not be resolved, which counts as outside.
type CheckResult struct {
	Inside  bool   `json:"inside"`
	Path    string `json:"path,omitempty"`
	Project string `json:"project,omitempty"`
	// IsDir: Path is an existing folder (the question names a file and its folder otherwise).
	IsDir bool   `json:"isdir,omitempty"`
	Error string `json:"error,omitempty"`
}

// ResolvePath returns the absolute, clean path a panel would show, with ~ expanded and every symbolic link resolved. A
// path that does not exist yet is resolved through its nearest existing parent; an entry that exists but cannot be
// resolved (a broken link, a folder that cannot be read) is an error.
func ResolvePath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("no path")
	}
	expanded, err := wavebase.ExpandHomeDir(path)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", err
	}
	var rest []string
	cur := abs
	for {
		resolved, err := filepath.EvalSymlinks(cur)
		if err == nil {
			return filepath.Join(append([]string{resolved}, rest...)...), nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		if _, lerr := os.Lstat(cur); lerr == nil {
			return "", fmt.Errorf("%s cannot be resolved: %w", cur, err)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", err
		}
		rest = append([]string{filepath.Base(cur)}, rest...)
		cur = parent
	}
}

// Check tells whether path lies inside project (equal to it or below it) once both are resolved. A path or a project
// that cannot be resolved counts as outside.
func Check(path string, project string) CheckResult {
	if project == "" {
		return CheckResult{Error: "no project"}
	}
	root, err := ResolvePath(project)
	if err != nil {
		return CheckResult{Error: err.Error()}
	}
	target, err := ResolvePath(path)
	if err != nil {
		return CheckResult{Project: root, Error: err.Error()}
	}
	rtn := CheckResult{Inside: molten.CheckPathInside(target, root), Path: target, Project: root}
	if info, err := os.Stat(target); err == nil {
		rtn.IsDir = info.IsDir()
	}
	return rtn
}

// Asker is who wrote a panel's meta, as wavesrv's router proves it (localroute.Caller): a window, an agent's terminal
// (its first name known), or anything else.
type Asker struct {
	IsUi      bool
	FirstName string
}

// TouchesFileMeta tells whether a meta write sets a panel's file, its approval or its origin.
func TouchesFileMeta(meta waveobj.MetaMapType) bool {
	for _, key := range []string{waveobj.MetaKey_File, ApprovedMetaKey, OriginMetaKey, OriginNameMetaKey} {
		if _, ok := meta[key]; ok {
			return true
		}
	}
	return false
}

// MetaFromAsker returns the meta to store for a write by asker, and whether it differs from meta (which is never
// modified). A window's write is kept as is: the panel's model clears the origin when the user moves it. Anything else
// cannot approve, and its file meta carries who asked.
func MetaFromAsker(meta waveobj.MetaMapType, asker Asker) (waveobj.MetaMapType, bool) {
	if asker.IsUi || !TouchesFileMeta(meta) {
		return meta, false
	}
	_, hasFile := meta[waveobj.MetaKey_File]
	rtn := make(waveobj.MetaMapType, len(meta)+2)
	for k, v := range meta {
		rtn[k] = v
	}
	delete(rtn, ApprovedMetaKey)
	delete(rtn, OriginMetaKey)
	delete(rtn, OriginNameMetaKey)
	if hasFile {
		rtn[OriginMetaKey] = OriginCommand
		rtn[OriginNameMetaKey] = nil
		if asker.FirstName != "" {
			rtn[OriginMetaKey] = OriginAgent
			rtn[OriginNameMetaKey] = asker.FirstName
		}
	}
	return rtn, true
}
