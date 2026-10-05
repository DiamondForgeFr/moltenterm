// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

const loginPathMarker = "__MOLTEN_PATH__"
const loginPathTimeout = 8 * time.Second

var loginPathOnce sync.Once
var loginPath string

// A Moltenterm opened from the Finder gets a bare PATH; git, gh, the project's tools and the coding agents are found
// through the user's login shell, read once.
func LoginPath() string {
	loginPathOnce.Do(func() {
		loginPath = os.Getenv("PATH")
		if runtime.GOOS == "windows" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), loginPathTimeout)
		defer cancel()
		shell := shellutil.DetectLocalShellPath()
		cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", "printf '\\n"+loginPathMarker+"%s\\n' \"$PATH\"")
		cmd.Stdin = nil
		out, err := cmd.Output()
		if err != nil && len(out) == 0 {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			if value, ok := strings.CutPrefix(line, loginPathMarker); ok && value != "" {
				loginPath = value
			}
		}
	})
	return loginPath
}

// LookPathIn finds an executable in pathList, the way exec.LookPath does with $PATH.
func LookPathIn(name string, pathList string) string {
	for _, dir := range filepath.SplitList(pathList) {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		if runtime.GOOS == "windows" && filepath.Ext(candidate) == "" {
			candidate += ".exe"
		}
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		if runtime.GOOS != "windows" && info.Mode()&0111 == 0 {
			continue
		}
		return candidate
	}
	return ""
}
