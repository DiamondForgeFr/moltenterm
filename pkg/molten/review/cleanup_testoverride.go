// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build moltentestoverride

package review

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// Test-only build (`-tags moltentestoverride`, never in a release or a gold): the real app's cleanup after a merge
// finds gh, git and bash in MOLTENTERM_TEST_REVIEW_CLEANUP_PATH instead of the login shell's PATH, so a test drives a
// fake gh and never writes to GitHub. Without the tag this file does not exist.
func init() {
	path := os.Getenv("MOLTENTERM_TEST_REVIEW_CLEANUP_PATH")
	if path == "" {
		return
	}
	log.Printf("molten: TEST BUILD, review cleanup programs from %s\n", path)
	cleanupRunner = func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		program := name
		if !filepath.IsAbs(name) {
			program = molten.LookPathIn(name, path)
		}
		if program == "" {
			return nil, fmt.Errorf("%s is not in the test PATH", name)
		}
		return mission.ExecRunner(ctx, dir, program, args...)
	}
}
