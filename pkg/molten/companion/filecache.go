// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"os"
	"sync"
)

// What the companion reads from a transcript is kept by its path, with the file's size, modification time and identity
// (#2142): Integration asks every few seconds, for every agent, and an unchanged transcript must not be read and
// decoded again. A transcript replaced under the same path (another file, or a smaller one) is always read again.

// openTranscript opens a transcript for the readers that discovery and the work folders use; a test counts the opens.
var openTranscript = os.Open

// fileStamp is what tells whether a file changed since it was read.
type fileStamp struct {
	size int64
	mod  int64
	info os.FileInfo
}

func stampOf(info os.FileInfo) fileStamp {
	return fileStamp{size: info.Size(), mod: info.ModTime().UnixNano(), info: info}
}

// unchanged: the same file, neither written nor replaced since.
func (s fileStamp) unchanged(info os.FileInfo) bool {
	return s.info != nil && s.size == info.Size() && s.mod == info.ModTime().UnixNano() && os.SameFile(s.info, info)
}

// grown: the same file, only appended to since (an agent's transcript is only appended to).
func (s fileStamp) grown(info os.FileInfo) bool {
	return s.info != nil && info.Size() >= s.size && os.SameFile(s.info, info)
}

type fileCacheEntry[T any] struct {
	stamp fileStamp
	value T
}

// fileCache keeps one value per file path; it is emptied when it holds max entries.
type fileCache[T any] struct {
	lock    sync.Mutex
	max     int
	entries map[string]fileCacheEntry[T]
}

func makeFileCache[T any](max int) *fileCache[T] {
	return &fileCache[T]{max: max, entries: map[string]fileCacheEntry[T]{}}
}

func (c *fileCache[T]) get(path string) (fileCacheEntry[T], bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	e, ok := c.entries[path]
	return e, ok
}

func (c *fileCache[T]) put(path string, info os.FileInfo, value T) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if len(c.entries) >= c.max {
		c.entries = map[string]fileCacheEntry[T]{}
	}
	c.entries[path] = fileCacheEntry[T]{stamp: stampOf(info), value: value}
}
