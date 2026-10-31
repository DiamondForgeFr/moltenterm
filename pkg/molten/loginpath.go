// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

const loginPathMarker = "__MOLTEN_PATH__"
const loginPathTimeout = 8 * time.Second

var loginPathOnce sync.Once
var loginPathLock sync.Mutex
var loginPath string

// loginPathReader is readLoginPath; tests replace it. ok is false when the shell gave no PATH.
var loginPathReader = readLoginPath

// LoginPathEnv replaces the login shell's PATH: a test instance names its fake gh and agents there, since the login
// shell would put the real ones back in front of the PATH it was given.
const LoginPathEnv = "MOLTENTERM_LOGIN_PATH"

func readLoginPath() (string, bool) {
	if override := os.Getenv(LoginPathEnv); override != "" {
		return override, true
	}
	if runtime.GOOS == "windows" {
		return os.Getenv("PATH"), true
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginPathTimeout)
	defer cancel()
	shell := shellutil.DetectLocalShellPath()
	cmd := spawns.Command(ctx, shell, "-l", "-i", "-c", "printf '\\n"+loginPathMarker+"%s\\n' \"$PATH\"")
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return "", false
	}
	value := ""
	for _, line := range strings.Split(string(out), "\n") {
		if found, ok := strings.CutPrefix(line, loginPathMarker); ok && found != "" {
			value = found
		}
	}
	return value, value != ""
}

func getLoginPath() string {
	loginPathLock.Lock()
	defer loginPathLock.Unlock()
	return loginPath
}

func setLoginPath(value string) {
	loginPathLock.Lock()
	defer loginPathLock.Unlock()
	loginPath = value
}

func loadLoginPath() {
	value, ok := loginPathReader()
	if !ok {
		value = os.Getenv("PATH")
	}
	setLoginPath(value)
}

// A Moltenterm opened from the Finder gets a bare PATH; git, gh, the project's tools and the coding agents are found
// through the user's login shell, read once and again on RefreshLoginPath.
func LoginPath() string {
	loginPathOnce.Do(loadLoginPath)
	return getLoginPath()
}

// RefreshLoginPath reads the login shell's PATH again (FR-ONB-002, #1667): an installer that adds its folder to the
// shell's rc file (Kimi Code's ~/.kimi-code/bin) is seen without a restart. The shell runs outside the lock, so other
// callers keep the previous PATH meanwhile; a failed read keeps it too.
func RefreshLoginPath() string {
	first := false
	loginPathOnce.Do(func() {
		first = true
		loadLoginPath()
	})
	if first {
		return getLoginPath()
	}
	if value, ok := loginPathReader(); ok {
		setLoginPath(value)
	}
	return getLoginPath()
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
