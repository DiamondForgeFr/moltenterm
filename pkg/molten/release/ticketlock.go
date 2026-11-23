// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// One release ticket per version (#2492): the readiness check and the preparation are two processes, run one after the
// other, and GitHub's listing of a milestone can lag a ticket put in it seconds before. Finding and creating the ticket
// hold a lock per repository and version, and the ticket made is written down beside the lock for the next process.

const (
	ticketDirName = "release-tickets"
	// Polled while another process finds or creates the ticket: the project's ticket tool takes about 20 s.
	ticketLockPoll = 100 * time.Millisecond
	ticketLockWait = 5 * time.Minute
	// A lock file whose owner is not written yet is being taken, not left behind.
	ticketLockFresh = 10 * time.Second
)

type ticketRecord struct {
	Repo    string `json:"repo"`
	Version string `json:"version"`
	Number  int    `json:"number"`
}

// ticketDir is where the locks and records of the release tickets are: MoltenTerm's data folder, shared by every
// checkout of the repository, else the repository's git folder (a plain shell, CI).
func (e *Env) ticketDir(ctx context.Context, root string) (string, error) {
	if e.DataDir != "" {
		return filepath.Join(e.DataDir, "molten", ticketDirName), nil
	}
	common, err := e.commonDir(ctx, root)
	if err != nil {
		return "", err
	}
	return filepath.Join(common, lockDirName, ticketDirName), nil
}

// ticketRepo names the repository the lock is for: its GitHub repository, so two checkouts of it share one lock.
func (e *Env) ticketRepo(ctx context.Context, p *Project) string {
	if repo := e.ciRepo(ctx, p.Root); repo != "" {
		return strings.ToLower(repo)
	}
	return p.Root
}

func ticketKey(repo string, base string) string {
	sum := sha256.Sum256([]byte(repo + "|" + base))
	return hex.EncodeToString(sum[:12])
}

// ticketSlot is the lock and the record of one version's release ticket.
type ticketSlot struct {
	lockPath   string
	recordPath string
	repo       string
	base       string
}

func (e *Env) ticketSlotOf(ctx context.Context, p *Project, base string) (*ticketSlot, error) {
	dir, err := e.ticketDir(ctx, p.Root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	repo := e.ticketRepo(ctx, p)
	key := ticketKey(repo, base)
	return &ticketSlot{lockPath: filepath.Join(dir, key+".lock"), recordPath: filepath.Join(dir, key+".json"), repo: repo, base: base}, nil
}

// lockTicket waits for the lock of the slot, taking over one its process left behind. The error says who holds it when
// the wait ends: the release then asks for --ticket rather than make a ticket it cannot be sure is the only one.
func (e *Env) lockTicket(ctx context.Context, s *ticketSlot) (func(), error) {
	deadline := time.Now().Add(ticketLockWait)
	told := false
	for {
		f, err := os.OpenFile(s.lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err == nil {
			fmt.Fprintf(f, "%d\n", os.Getpid())
			f.Close()
			return func() { os.Remove(s.lockPath) }, nil
		}
		if !os.IsExist(err) {
			return nil, err
		}
		pid := lockOwner(s.lockPath)
		if !ticketLockHeld(s.lockPath, pid) {
			os.Remove(s.lockPath)
			continue
		}
		if !told {
			told = true
			if e.ticketLockWaiting != nil {
				e.ticketLockWaiting()
			}
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("another release step (pid %d) has been finding or creating the release ticket of %s for %s; pass --ticket N", pid, s.base, ticketLockWait)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(ticketLockPoll):
		}
	}
}

func ticketLockHeld(path string, pid int) bool {
	if pid > 0 {
		return processAlive(pid)
	}
	info, err := os.Stat(path)
	return err == nil && time.Since(info.ModTime()) < ticketLockFresh
}

// recordedTicket is the ticket the release last chose for the version, 0 for none.
func (s *ticketSlot) recordedTicket() int {
	data, err := os.ReadFile(s.recordPath)
	if err != nil {
		return 0
	}
	var r ticketRecord
	if json.Unmarshal(data, &r) != nil || r.Repo != s.repo || r.Version != s.base {
		return 0
	}
	return r.Number
}

func (s *ticketSlot) record(n int) error {
	data, err := json.Marshal(ticketRecord{Repo: s.repo, Version: s.base, Number: n})
	if err != nil {
		return err
	}
	tmp := s.recordPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, s.recordPath)
}
