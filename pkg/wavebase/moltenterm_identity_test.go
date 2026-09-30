// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wavebase

import (
	"path/filepath"
	"strings"
	"testing"
)

// The cache directory belongs to Moltenterm, not to an installed Wave (FR-FORK-002).
func TestCacheDirIsMoltenterms(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	previousDev := Dev_VarCache
	t.Cleanup(func() { Dev_VarCache = previousDev })

	Dev_VarCache = ""
	if got := resolveWaveCachesDir(); !strings.HasSuffix(filepath.Clean(got), MoltentermDirName) &&
		!strings.HasSuffix(filepath.Clean(got), filepath.Join(MoltentermDirName, "Cache")) {
		t.Fatalf("release cache dir must be Moltenterm's, got %q", got)
	}

	Dev_VarCache = "1"
	if got := resolveWaveCachesDir(); !strings.Contains(got, MoltentermDirName+"-dev") {
		t.Fatalf("dev cache dir must be Moltenterm's dev directory, got %q", got)
	}
	if got := resolveWaveCachesDir(); strings.Contains(got, "waveterm") {
		t.Fatalf("cache dir must not be Wave's, got %q", got)
	}
}
