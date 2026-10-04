// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bytes"
	"io"
	"os"
)

const (
	// A transcript larger than this is read from its last tailStartBytes only (its start would cost seconds and
	// memory for answers long scrolled away).
	tailFullReadMax = 64 * 1024 * 1024
	tailStartBytes  = 32 * 1024 * 1024
	// At most this much is read per poll, so a burst never blocks the follower for long.
	tailChunkMax = 16 * 1024 * 1024
	// Longer records (a large tool result, an image) are skipped whole.
	tailLineMax  = 8 * 1024 * 1024
	tailReadSize = 256 * 1024
)

// follower reads a transcript as it grows: only the appended bytes, complete lines only (the last line may be
// half-written), and starts over when the file shrinks or is replaced. The file is opened read-only.
type follower struct {
	path     string
	file     *os.File
	info     os.FileInfo
	offset   int64
	partial  []byte
	skipping bool
	buf      []byte
}

func openFollower(path string) (*follower, error) {
	f := &follower{path: path, buf: make([]byte, tailReadSize)}
	if err := f.open(); err != nil {
		return nil, err
	}
	return f, nil
}

func (f *follower) open() error {
	file, err := os.Open(f.path)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	if f.file != nil {
		f.file.Close()
	}
	f.file, f.info = file, info
	f.offset, f.partial, f.skipping = 0, nil, false
	return nil
}

func (f *follower) close() {
	if f.file != nil {
		f.file.Close()
		f.file = nil
	}
}

// poll reads what was appended since the last call and hands each complete line to emit. reset tells that the file
// was replaced or truncated: what was read before no longer holds. more tells that unread bytes remain.
func (f *follower) poll(emit func(line []byte)) (reset bool, more bool, err error) {
	cur, err := os.Stat(f.path)
	if err != nil {
		return false, false, err
	}
	if !os.SameFile(cur, f.info) {
		if err := f.open(); err != nil {
			return false, false, err
		}
		reset = true
	}
	size := cur.Size()
	if size < f.offset {
		f.offset, f.partial, f.skipping = 0, nil, false
		reset = true
	}
	if f.offset == 0 && size > tailFullReadMax {
		f.offset = size - tailStartBytes
		// The first line read is most likely cut.
		f.skipping = true
	}
	end := size
	if end-f.offset > tailChunkMax {
		end = f.offset + tailChunkMax
	}
	for f.offset < end {
		want := int64(len(f.buf))
		if end-f.offset < want {
			want = end - f.offset
		}
		n, rerr := f.file.ReadAt(f.buf[:want], f.offset)
		if n > 0 {
			f.offset += int64(n)
			f.feed(f.buf[:n], emit)
		}
		if rerr != nil && rerr != io.EOF {
			return reset, false, rerr
		}
		if n == 0 {
			break
		}
	}
	return reset, f.offset < size, nil
}

func (f *follower) feed(data []byte, emit func(line []byte)) {
	for len(data) > 0 {
		idx := bytes.IndexByte(data, '\n')
		if idx < 0 {
			if !f.skipping {
				f.partial = append(f.partial, data...)
				if len(f.partial) > tailLineMax {
					f.partial, f.skipping = nil, true
				}
			}
			return
		}
		chunk := data[:idx]
		data = data[idx+1:]
		if f.skipping {
			f.skipping = false
			f.partial = nil
			continue
		}
		var line []byte
		if len(f.partial) > 0 {
			line = append(f.partial, chunk...)
			f.partial = nil
		} else {
			line = chunk
		}
		if len(line) > tailLineMax {
			continue
		}
		if len(bytes.TrimSpace(line)) > 0 {
			emit(line)
		}
	}
}
