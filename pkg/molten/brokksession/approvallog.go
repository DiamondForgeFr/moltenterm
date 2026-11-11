// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// The approvals boss:autoapprove made, kept in a file of his folder, as the coffee approvals are (#2257, second
// review): each one is written before his agent gets the allow, so a burst or a restart loses none, and his talk window
// reads them from there. The file is hidden, so his agent never edits it without asking (permitguard.go).

// ApprovalLogName is the file, in his folder.
const ApprovalLogName = ".molten-approvals.jsonl"

// maxApprovalLogRead bounds what one reading looks at, from the end of the file.
const maxApprovalLogRead = 256 * 1024

type ApprovalLog struct {
	path string
	lock sync.Mutex
}

func MakeApprovalLog(dir string) *ApprovalLog {
	return &ApprovalLog{path: filepath.Join(dir, ApprovalLogName)}
}

// Append writes one approval and syncs it to the disk.
func (l *ApprovalLog) Append(a AutoApproval) error {
	line, err := json.Marshal(a)
	if err != nil {
		return err
	}
	l.lock.Lock()
	defer l.lock.Unlock()
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

// Since lists the approvals made at or after since, at most limit of the latest, oldest first.
func (l *ApprovalLog) Since(since int64, limit int) []AutoApproval {
	l.lock.Lock()
	defer l.lock.Unlock()
	f, err := os.Open(l.path)
	if err != nil {
		return nil
	}
	defer f.Close()
	if info, err := f.Stat(); err == nil && info.Size() > maxApprovalLogRead {
		_, _ = f.Seek(info.Size()-maxApprovalLogRead, 0)
	}
	var rtn []AutoApproval
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), maxApprovalLogRead)
	for scanner.Scan() {
		var a AutoApproval
		// The first line after a seek may be cut: it does not parse, and is skipped.
		if json.Unmarshal(scanner.Bytes(), &a) != nil || a.Id == "" || a.At < since {
			continue
		}
		rtn = append(rtn, a)
	}
	if len(rtn) > limit {
		rtn = rtn[len(rtn)-limit:]
	}
	return rtn
}
