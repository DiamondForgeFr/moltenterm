// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// The coffee approvals' log (DS-SHELL-112): one JSON object per line in MoltenTerm's data folder, readable after a
// night away; the state keeps only the latest. Past maxApprovalLogBytes the file moves to .1 (the older .1 goes).

const (
	ApprovalLogDir      = "molten"
	ApprovalLogFile     = "coffee-approvals.jsonl"
	maxApprovalLogBytes = 2 * 1024 * 1024
)

type approvalLog struct {
	lock sync.Mutex
	path string
}

func makeApprovalLog(dataDir string) *approvalLog {
	return &approvalLog{path: filepath.Join(dataDir, ApprovalLogDir, ApprovalLogFile)}
}

func (l *approvalLog) append(a Approval) error {
	line, err := json.Marshal(a)
	if err != nil {
		return err
	}
	l.lock.Lock()
	defer l.lock.Unlock()
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return err
	}
	if info, err := os.Stat(l.path); err == nil && info.Size()+int64(len(line)) > maxApprovalLogBytes {
		if err := os.Rename(l.path, l.path+".1"); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(line, '\n'))
	return err
}
