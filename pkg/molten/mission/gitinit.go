// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const gitInitTimeout = 30 * time.Second

type GitInitRequest struct {
	Dir string `json:"dir"`
}

// InitGit runs `git init` in a linked project folder that is not inside a repository yet (FR-SHELL-053: "Initialize
// git here", after the user confirmed), then re-reads it so the panels follow at once. A folder already inside a
// repository is refused: a nested repository would hide the project's own history.
func (c *Collector) InitGit(req GitInitRequest) (Snapshot, error) {
	if err := checkDir(req.Dir); err != nil {
		return Snapshot{}, err
	}
	dir := filepath.Clean(req.Dir)
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return Snapshot{}, uimsg.Errorf(uimsg.Make("mission.git.noFolder", "dir", dir), "the folder %s does not exist", dir)
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitInitTimeout)
	defer cancel()
	if _, err := c.run(ctx, dir, "git", "rev-parse", "--git-dir"); err == nil {
		return Snapshot{}, uimsg.Errorf(uimsg.Make("mission.git.alreadyRepo", "dir", dir), "%s is already inside a git repository", dir)
	}
	if _, err := c.run(ctx, dir, "git", "init", "--quiet"); err != nil {
		return Snapshot{}, err
	}
	c.forgetGithub(dir)
	return c.Get(dir, 0, true)
}

// forgetGithub drops the GitHub read's age: the one made before git init says "not a git repository" and would stay
// for a minute (minGithubInterval), so the Integration panel would call the new repository unreadable (FR-REV-001
// AC15) instead of asking for its remote.
func (c *Collector) forgetGithub(dir string) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.stateLocked(dir).snap.GithubAt = 0
}
