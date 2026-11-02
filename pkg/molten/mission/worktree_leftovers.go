// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// A worktree removal git accepted can still end in "Directory not empty" (#716): git unregisters the worktree and
// deletes its files, then something writes into the folder before the last rmdir (the system's file browser metadata,
// an indexer, a file watcher). The worktree is gone for git; only a folder of leftovers stays. TreeRemover tells that
// case from a real failure (git still lists the worktree) and removes the leftovers, retried a few times with a short
// backoff. It only ever removes the folder it was asked to, once git no longer lists it, and never the home folder,
// a folder holding the repository or a folder with a .git directory (a repository of its own).

// leftoverBackoff: the waits between the tries at removing the leftovers (3 tries over about 2 s).
var leftoverBackoff = []time.Duration{500 * time.Millisecond, 1500 * time.Millisecond}

// TreeRemoval is how a worktree removal ended when git accepted it.
type TreeRemoval struct {
	// LeftoversRemoved: git could not delete the whole folder; the files left in it were removed after.
	LeftoversRemoved bool
	// Leftover: the folder that stays after the worktree was unregistered, and why (LeftoverError). Not a failure:
	// the worktree is gone for git, only files outside git stay.
	Leftover      string
	LeftoverError string
}

type TreeRemover struct {
	Run  Runner
	Home string
	// RemoveAll removes the leftover folder (os.RemoveAll); Wait waits between the tries (false: the context ended).
	// Tests replace them.
	RemoveAll func(path string) error
	Wait      func(ctx context.Context, d time.Duration) bool
}

func MakeTreeRemover(run Runner) TreeRemover {
	home, _ := os.UserHomeDir()
	return TreeRemover{Run: run, Home: home, RemoveAll: os.RemoveAll, Wait: waitFor}
}

func waitFor(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

const (
	refusalHome       = "the home folder"
	refusalRepository = "it holds its repository"
)

// worktreeRefusal names a folder MoltenTerm never removes, whatever git says: the home folder or one of its parents,
// the root, or a folder holding the repository's main checkout.
func worktreeRefusal(path string, main string, home string) string {
	real := realPath(path)
	if home != "" && pathInside(realPath(home), real) {
		return refusalHome
	}
	if real == "/" || (main != "" && pathInside(realPath(main), real)) {
		return refusalRepository
	}
	return ""
}

// Registered tells whether the repository of main still lists the worktree at path.
func (t TreeRemover) Registered(ctx context.Context, main string, path string) (bool, error) {
	out, err := t.Run(ctx, main, "git", "worktree", "list", "--porcelain")
	if err != nil {
		return false, err
	}
	found, _, _ := listedWorktree(string(out), path)
	return found, nil
}

// Remove runs git worktree remove from the main checkout. When git fails but no longer lists the worktree, the
// removal went through and only leftovers stay: they are removed (RemoveLeftover), and a folder that still resists is
// reported in the result, not as an error. An error means git refused and still lists the worktree, or the folder
// could not be checked.
func (t TreeRemover) Remove(ctx context.Context, main string, path string, force bool) (TreeRemoval, error) {
	forces := 0
	if force {
		forces = 1
	}
	return t.remove(ctx, main, path, forces)
}

// RemoveLocked removes a locked worktree: git asks for --force twice (#1028). Callers check first that the developer
// confirmed removing that locked worktree.
func (t TreeRemover) RemoveLocked(ctx context.Context, main string, path string) (TreeRemoval, error) {
	return t.remove(ctx, main, path, 2)
}

func (t TreeRemover) remove(ctx context.Context, main string, path string, forces int) (TreeRemoval, error) {
	args := []string{"worktree", "remove"}
	for i := 0; i < forces; i++ {
		args = append(args, "--force")
	}
	args = append(args, "--", path)
	_, gitErr := t.Run(ctx, main, "git", args...)
	if gitErr == nil {
		return TreeRemoval{}, nil
	}
	registered, err := t.Registered(ctx, main, path)
	if err != nil || registered {
		return TreeRemoval{}, gitErr
	}
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return TreeRemoval{}, nil
	}
	return t.RemoveLeftover(ctx, main, path)
}

// RemoveLeftover removes the folder a worktree left after git unregistered it, retried with leftoverBackoff.
func (t TreeRemover) RemoveLeftover(ctx context.Context, main string, path string) (TreeRemoval, error) {
	if !filepath.IsAbs(path) {
		return TreeRemoval{}, fmt.Errorf("%s is not an absolute path", path)
	}
	path = filepath.Clean(path)
	if refused := worktreeRefusal(path, main, t.Home); refused != "" {
		return TreeRemoval{}, fmt.Errorf("MoltenTerm does not remove %s: %s", path, refused)
	}
	if info, err := os.Lstat(filepath.Join(path, ".git")); err == nil && info.IsDir() {
		return TreeRemoval{}, fmt.Errorf("MoltenTerm does not remove %s: it holds a repository", path)
	}
	registered, err := t.Registered(ctx, main, path)
	if err != nil {
		return TreeRemoval{}, err
	}
	if registered {
		return TreeRemoval{}, fmt.Errorf("%s is still a worktree of its repository", path)
	}
	removeAll, wait := t.RemoveAll, t.Wait
	if removeAll == nil {
		removeAll = os.RemoveAll
	}
	if wait == nil {
		wait = waitFor
	}
	var lastErr error
	for i := 0; ; i++ {
		lastErr = removeAll(path)
		if _, statErr := os.Lstat(path); errors.Is(statErr, os.ErrNotExist) {
			return TreeRemoval{LeftoversRemoved: true}, nil
		}
		if i >= len(leftoverBackoff) || !wait(ctx, leftoverBackoff[i]) {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("the folder is still there")
	}
	return TreeRemoval{Leftover: path, LeftoverError: lastErr.Error()}, nil
}
