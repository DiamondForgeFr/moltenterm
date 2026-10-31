// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package fileconfine

import (
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

func TestRoutePolicy(t *testing.T) {
	policy := route().Policy
	if !policy.Admits(CheckCommand, localroute.Caller{IsWindow: true}) {
		t.Fatal("a window asks")
	}
	if !policy.Admits(CheckCommand, localroute.Caller{IsLocalTerminal: true}) {
		t.Fatal("a local terminal asks (molten files)")
	}
	if policy.Admits(CheckCommand, localroute.Caller{}) {
		t.Fatal("a remote host does not")
	}
}

func TestHandle(t *testing.T) {
	project, outside := tree(t)
	rtn, err := handle(CheckCommand, map[string]any{"path": filepath.Join(project, "src"), "project": project})
	if err != nil || !rtn.(CheckResult).Inside || !rtn.(CheckResult).IsDir {
		t.Fatalf("inside folder: %+v %v", rtn, err)
	}
	rtn, err = handle(CheckCommand, map[string]any{"path": outside, "project": project})
	if err != nil || rtn.(CheckResult).Inside {
		t.Fatalf("outside folder: %+v %v", rtn, err)
	}
	if _, err := handle(CheckCommand, map[string]any{"path": outside}); err == nil {
		t.Fatal("a check without a project is refused")
	}
	if _, err := handle("other", nil); err == nil {
		t.Fatal("an unknown command is refused")
	}
}
