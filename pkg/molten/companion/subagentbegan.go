// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"io"
	"os"
	"sync"
)

// When a Claude Code sub-agent's transcript began (#2502): the time of its first record, which the popover and the
// companion show as its age. It never changes once the first record is written, so it is read once per file.

const (
	subagentHeadBytes = 16 * 1024
	maxBeganCache     = 512
)

var transcriptBegan = struct {
	lock    sync.Mutex
	entries map[string]int64
}{entries: map[string]int64{}}

// claudeTranscriptBegan is the time of the first record of a sub-agent's transcript, in Unix milliseconds; 0 for a file
// that has none yet.
func claudeTranscriptBegan(path string) int64 {
	transcriptBegan.lock.Lock()
	at, ok := transcriptBegan.entries[path]
	transcriptBegan.lock.Unlock()
	if ok {
		return at
	}
	head, err := readFileHead(path, subagentHeadBytes)
	if err != nil {
		return 0
	}
	at = firstRecordTime(head)
	if at == 0 {
		return 0
	}
	transcriptBegan.lock.Lock()
	defer transcriptBegan.lock.Unlock()
	if len(transcriptBegan.entries) >= maxBeganCache {
		transcriptBegan.entries = map[string]int64{}
	}
	transcriptBegan.entries[path] = at
	return at
}

// firstRecordTime is the timestamp of the first complete line of a head that has one.
func firstRecordTime(head []byte) int64 {
	for _, line := range splitLines(head) {
		if at := recordStampMs(line); at > 0 {
			return at
		}
	}
	return 0
}

// readFileHead reads at most max bytes from the start of a regular file.
func readFileHead(path string, max int64) ([]byte, error) {
	f, err := openTranscript(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, os.ErrInvalid
	}
	return io.ReadAll(io.LimitReader(f, max))
}
