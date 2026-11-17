// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// The look reads only what was written since the last one (FR-BOSS-012 AC2, AC3). Electron main renames waveapp.log to
// logs/waveapp.N.log when it rotates it, at start and, since #2335, while it runs, and empties it in place for Clear
// logs. The watch knows the file it read by its identity (device and inode where the system gives them) and by a
// fingerprint of its first bytes: another identity, another fingerprint or a file shorter than the place reached means a
// new file, read from its start, after the end of the rotated one when it is found in logs/.

const (
	LogFileName = "waveapp.log"
	LogsDirName = "logs"

	// InitialTail: what the very first look reads, from the end of the log; the history before it is left alone.
	InitialTail = 4 << 20
	// MaxLookBytes: what one look reads at most; past it, it skips ahead to the newest part.
	MaxLookBytes = 32 << 20
	// fingerprintBytes: how much of the start of a file tells it apart from the next one (its first stamp and line).
	fingerprintBytes = 64
)

var rotatedNameRe = regexp.MustCompile(`^waveapp\.\d+\.log$`)

// fileMark is where the last look stopped.
type fileMark struct {
	// Seen: a look already ran; the first one starts near the end.
	Seen  bool   `json:"seen,omitempty"`
	Ident string `json:"ident,omitempty"`
	// Fingerprint: a digest of the file's first Head bytes (at most fingerprintBytes), "" for an empty file.
	Fingerprint string `json:"fingerprint,omitempty"`
	Head        int64  `json:"head,omitempty"`
	Offset      int64  `json:"offset"`
}

// readOut is what a look read: the new bytes in order (the rotated file's end, then the current file's new part),
// cut at a line's end, and how much was written that it skipped. unread: the rotated files written since the last
// look that it did not read (several rotations between two looks), counted in the log's growth at their last write.
type readOut struct {
	chunks  [][]byte
	skipped int64
	unread  []timedBytes
}

type timedBytes struct {
	at time.Time
	n  int64
}

func (r readOut) size() int64 {
	var n int64
	for _, c := range r.chunks {
		n += int64(len(c))
	}
	return n
}

// fingerprintOf is a digest of the file's first n bytes, "" when n is 0 or the file is shorter than that.
func fingerprintOf(path string, n int64) string {
	if n <= 0 {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, n)
	if _, err := io.ReadFull(f, buf); err != nil {
		return ""
	}
	sum := sha256.Sum256(buf)
	return hex.EncodeToString(sum[:8])
}

// sameFile: the mark names this file, whose first mark.Head bytes digest to fingerprint. Without an identity on either
// side, the fingerprint decides alone.
func sameFile(mark fileMark, ident string, fingerprint string) bool {
	if mark.Ident != "" && ident != "" && mark.Ident != ident {
		return false
	}
	if mark.Fingerprint != "" && fingerprint != mark.Fingerprint {
		return false
	}
	if mark.Ident == "" || ident == "" {
		return mark.Fingerprint != ""
	}
	return true
}

// readRange reads [from, to) of the file, at most budget bytes: past it, it keeps the newest part and starts at the next
// line. whole: the file is done (a rotated one), so its last line counts even without its end of line; otherwise an
// unfinished last line waits for the next look. It answers the bytes, the place reached and what it skipped.
func readRange(path string, from int64, to int64, budget int64, whole bool) ([]byte, int64, int64, error) {
	if to <= from {
		return nil, from, 0, nil
	}
	skipped := int64(0)
	start := from
	if to-from > budget {
		skipped = to - from - budget
		start = to - budget
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, from, 0, err
	}
	defer f.Close()
	buf := make([]byte, to-start)
	n, err := f.ReadAt(buf, start)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, from, 0, err
	}
	buf = buf[:n]
	if skipped > 0 {
		cut := bytes.IndexByte(buf, '\n')
		if cut < 0 {
			return nil, start + int64(n), skipped + int64(n), nil
		}
		skipped += int64(cut + 1)
		buf = buf[cut+1:]
		start += int64(cut + 1)
	}
	if !whole {
		end := bytes.LastIndexByte(buf, '\n')
		if end < 0 {
			return nil, start, skipped, nil
		}
		buf = buf[:end+1]
	}
	return buf, start + int64(len(buf)), skipped, nil
}

// findRotated is the file of logs/ the mark names, "" when none does.
func findRotated(logsDir string, mark fileMark) string {
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() || !rotatedNameRe.MatchString(e.Name()) {
			continue
		}
		path := filepath.Join(logsDir, e.Name())
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if sameFile(mark, identOf(info), fingerprintOf(path, mark.Head)) {
			return path
		}
	}
	return ""
}

// rotatedSince lists the rotated files of logs/ last written after since (Unix ms), except the one already read.
func rotatedSince(logsDir string, since int64, except string) []timedBytes {
	if since <= 0 {
		return nil
	}
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		return nil
	}
	var out []timedBytes
	for _, e := range entries {
		if e.IsDir() || !rotatedNameRe.MatchString(e.Name()) {
			continue
		}
		path := filepath.Join(logsDir, e.Name())
		info, err := e.Info()
		if err != nil || path == except || info.ModTime().UnixMilli() <= since {
			continue
		}
		out = append(out, timedBytes{at: info.ModTime(), n: info.Size()})
	}
	return out
}

// readNew reads what was written to the log since mark, and answers the mark of the next look. since: when the last
// look ran (Unix ms, 0 for none).
func readNew(path string, logsDir string, mark fileMark, since int64) (readOut, fileMark, error) {
	var out readOut
	budget := int64(MaxLookBytes)
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		info = nil
	} else if err != nil {
		return out, mark, err
	}
	var ident, fingerprint, then string
	var size, head int64
	if info != nil {
		ident, size = identOf(info), info.Size()
		head = min(size, fingerprintBytes)
		fingerprint, then = fingerprintOf(path, head), fingerprintOf(path, mark.Head)
	}
	if !mark.Seen {
		next := fileMark{Seen: true, Ident: ident, Fingerprint: fingerprint, Head: head}
		if info == nil {
			return out, next, nil
		}
		chunk, offset, _, err := readRange(path, max(0, size-InitialTail), size, InitialTail, false)
		if err != nil {
			return out, mark, err
		}
		if size > InitialTail {
			chunk = dropFirstLine(chunk)
		}
		next.Offset = offset
		out.chunks = appendChunk(out.chunks, chunk)
		return out, next, nil
	}
	same := info != nil && sameFile(mark, ident, then) && size >= mark.Offset
	if !same {
		// The file read last time was rotated away (its end is read in logs/) or emptied in place (nothing left to read).
		emptiedInPlace := info != nil && mark.Ident != "" && ident == mark.Ident
		if !emptiedInPlace {
			rotated := findRotated(logsDir, mark)
			out.unread = rotatedSince(logsDir, since, rotated)
			if rotated != "" {
				if rinfo, err := os.Stat(rotated); err == nil {
					chunk, _, skipped, err := readRange(rotated, mark.Offset, rinfo.Size(), budget, true)
					if err == nil {
						out.chunks = appendChunk(out.chunks, chunk)
						out.skipped += skipped
						budget -= int64(len(chunk))
					}
				}
			}
		}
		mark = fileMark{Seen: true}
	}
	next := fileMark{Seen: true, Ident: ident, Fingerprint: fingerprint, Head: head, Offset: mark.Offset}
	if info == nil {
		return out, next, nil
	}
	chunk, offset, skipped, err := readRange(path, mark.Offset, size, max(budget, 1<<20), false)
	if err != nil {
		return out, mark, err
	}
	out.chunks = appendChunk(out.chunks, chunk)
	out.skipped += skipped
	next.Offset = offset
	return out, next, nil
}

func appendChunk(chunks [][]byte, chunk []byte) [][]byte {
	if len(chunk) == 0 {
		return chunks
	}
	return append(chunks, chunk)
}

// dropFirstLine leaves out a line the first look started in the middle of.
func dropFirstLine(chunk []byte) []byte {
	cut := bytes.IndexByte(chunk, '\n')
	if cut < 0 {
		return nil
	}
	return chunk[cut+1:]
}
