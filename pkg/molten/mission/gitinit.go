// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const gitInitTimeout = 30 * time.Second

// ErrInsideRepo: the folder is inside a git repository already.
var ErrInsideRepo = errors.New("already inside a git repository")

type GitInitRequest struct {
	Dir string `json:"dir"`
}

// InsideRepo: dir is inside a git repository, as git itself sees it.
func InsideRepo(ctx context.Context, run Runner, dir string) bool {
	_, err := run(ctx, dir, "git", "rev-parse", "--git-dir")
	return err == nil
}

// InitRepo runs `git init` in dir, unless dir is inside a repository already (ErrInsideRepo): a nested repository would
// hide the project's own history. It is the rule of InitGit (FR-SHELL-053), which a brainstorm's new project folder
// follows too (FR-BOSS-010 AC15, #2250).
func InitRepo(ctx context.Context, run Runner, dir string) error {
	if InsideRepo(ctx, run, dir) {
		return ErrInsideRepo
	}
	_, err := run(ctx, dir, "git", "init", "--quiet")
	return err
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
	err = InitRepo(ctx, c.run, dir)
	if errors.Is(err, ErrInsideRepo) {
		return Snapshot{}, uimsg.Errorf(uimsg.Make("mission.git.alreadyRepo", "dir", dir), "%s is already inside a git repository", dir)
	}
	if err != nil {
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
