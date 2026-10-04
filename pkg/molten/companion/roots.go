// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Extra session roots (#141): an agent started with CLAUDE_CONFIG_DIR or CODEX_HOME set in the user's shell keeps its
// sessions where wavesrv cannot see (wavesrv does not inherit the shell's environment). The setting
// agent:sessionroots lists, per agent, such configuration folders; the companion reads the agent's session folder
// inside each (projects/ for Claude Code, sessions/ for Codex) with the same checks as the default one. A folder is
// used only when it is an absolute path (~ expanded) to an existing directory the user owns and others cannot write
// to: a session root is where the companion accepts transcripts a hook reports.

const maxExtraRoots = 8

var sessionSubdirs = map[string]string{"claude": "projects", "codex": "sessions"}

var configuredRootsLock sync.Mutex
var configuredRoots func() map[string][]string

// SetConfiguredRoots tells where the setting is read (wavesrv's configuration; tests replace it).
func SetConfiguredRoots(read func() map[string][]string) {
	configuredRootsLock.Lock()
	defer configuredRootsLock.Unlock()
	configuredRoots = read
}

func readConfiguredRoots(agent string) []string {
	configuredRootsLock.Lock()
	read := configuredRoots
	configuredRootsLock.Unlock()
	if read == nil {
		return nil
	}
	return read()[agent]
}

var rejectedRootsLock sync.Mutex
var rejectedRoots = map[string]bool{}

// Each rejected folder is logged once (its path only).
func logRejectedRoot(agent string, folder string, err error) {
	rejectedRootsLock.Lock()
	defer rejectedRootsLock.Unlock()
	key := agent + "\x00" + folder
	if rejectedRoots[key] || len(rejectedRoots) > 100 {
		return
	}
	rejectedRoots[key] = true
	log.Printf("molten: agent:sessionroots: %s folder %q ignored: %v\n", agent, folder, err)
}

// checkRootFolder validates one configured folder and returns it resolved.
func checkRootFolder(folder string) (string, error) {
	folder = strings.TrimSpace(folder)
	if folder == "" || len(folder) > MaxPathBytes || strings.ContainsRune(folder, 0) {
		return "", fmt.Errorf("invalid path")
	}
	if folder == "~" || strings.HasPrefix(folder, "~/") {
		home := homeDir()
		if home == "" {
			return "", fmt.Errorf("no home folder")
		}
		folder = filepath.Join(home, strings.TrimPrefix(folder, "~"))
	}
	if !filepath.IsAbs(folder) {
		return "", fmt.Errorf("not an absolute path")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(folder))
	if err != nil {
		return "", fmt.Errorf("not found")
	}
	if err := checkPrivateDir(resolved); err != nil {
		return "", err
	}
	return resolved, nil
}

// ExtraSessionRoots returns the session folders of the agent's configured folders that pass the checks.
func ExtraSessionRoots(agent string, folders []string) []string {
	sub := sessionSubdirs[agent]
	if sub == "" {
		return nil
	}
	var rtn []string
	seen := map[string]bool{}
	for _, folder := range folders {
		if len(rtn) >= maxExtraRoots {
			logRejectedRoot(agent, folder, fmt.Errorf("more than %d folders", maxExtraRoots))
			continue
		}
		resolved, err := checkRootFolder(folder)
		if err != nil {
			logRejectedRoot(agent, folder, err)
			continue
		}
		root := filepath.Join(resolved, sub)
		// The session folder itself, when it exists, passes the same checks (it may be a link elsewhere).
		if real, err := filepath.EvalSymlinks(root); err == nil {
			if err := checkPrivateDir(real); err != nil {
				logRejectedRoot(agent, folder, err)
				continue
			}
		}
		if seen[root] {
			continue
		}
		seen[root] = true
		rtn = append(rtn, root)
	}
	return rtn
}

func withExtraRoots(agent string, roots []string) []string {
	for _, root := range ExtraSessionRoots(agent, readConfiguredRoots(agent)) {
		dup := false
		for _, r := range roots {
			if samePath(r, root) {
				dup = true
				break
			}
		}
		if !dup {
			roots = append(roots, root)
		}
	}
	return roots
}

func checkPrivateDir(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("not found")
	}
	if !info.IsDir() {
		return fmt.Errorf("not a folder")
	}
	return checkOwner(info)
}
