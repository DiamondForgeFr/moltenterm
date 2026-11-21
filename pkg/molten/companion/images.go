// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Pasted images (#2455, FR-SHELL-018): the message a companion shows may name an image the developer pasted ("[Image
// #3]"). The view carries the text only. When the popover of such a chip opens, the window asks wavesrv for the image,
// which reads it from the session's own transcript: the image it holds inline, or the file it records. The window never
// names a path, so a request cannot point at a file of its choosing; a path the transcript records is served only if it
// is a regular image file of a known type and small enough. Nothing is uploaded and no copy is written.

const (
	// MaxImageBytes is the largest image served: the window holds it in memory, as a data URL.
	MaxImageBytes = 6 * 1024 * 1024
	// A record's line holds the image as base64 (4/3 of its size) next to the record's other fields.
	imageLineMax = 12 * 1024 * 1024
	// At most this much of a transcript is read to find one image.
	imageScanMax = 1 << 30
	imageMaxN    = 1 << 20
	imageReadBuf = 1 << 20
)

// ImageView is a pasted image for the window: the bytes of the image (base64 on the wire) and their media type.
type ImageView struct {
	Mime string `json:"mime"`
	Data []byte `json:"data"`
}

// ImageFinder is an adapter whose transcripts hold the pasted images of its agent's user messages.
type ImageFinder interface {
	// FindImages reads the transcript and gives where the image numbered n may be found, one candidate per message
	// that holds it. at is the time (Unix ms) of the message that names it, or 0 when the window does not know.
	FindImages(path string, n int, at int64) ([]imageCandidate, error)
}

// imageCandidate is one place an image may be read from: its base64 text as the transcript holds it, or the path the
// transcript records for it. Neither is trusted: readImage decodes and checks what it gets.
type imageCandidate struct {
	at   int64
	b64  string
	path string
}

// imageScanLock lets one transcript scan run at a time: a scan reads up to a whole transcript and holds a few
// megabytes, and a window's hover would otherwise start one per chip.
var imageScanLock sync.Mutex

func errNoImage() error {
	return uimsg.Errorf(uimsg.Make("companion.noimage"), "no such image in the session")
}

func (m *Manager) Image(blockId string, n int, at int64) (ImageView, error) {
	w := m.watcher(blockId)
	if w == nil {
		return ImageView{}, errNotOpen()
	}
	return w.image(n, at)
}

func (w *watcher) image(n int, at int64) (ImageView, error) {
	w.lock.Lock()
	path := w.path
	hasSession := w.session != nil
	w.lock.Unlock()
	if !hasSession || path == "" {
		return ImageView{}, errNoSession()
	}
	finder, ok := w.adapter.(ImageFinder)
	if !ok {
		return ImageView{}, errNoImage()
	}
	return readSessionImage(finder, path, n, at)
}

// readSessionImage finds the image numbered n in the transcript and reads it: the candidate whose message is nearest
// to at, an inline image before a recorded path of the same message.
func readSessionImage(finder ImageFinder, path string, n int, at int64) (ImageView, error) {
	if n < 1 || n > imageMaxN {
		return ImageView{}, errNoImage()
	}
	imageScanLock.Lock()
	defer imageScanLock.Unlock()
	candidates, err := finder.FindImages(path, n, at)
	if err != nil || len(candidates) == 0 {
		return ImageView{}, errNoImage()
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		di, dj := imageDistance(candidates[i].at, at), imageDistance(candidates[j].at, at)
		if di != dj {
			return di < dj
		}
		return candidates[i].b64 != "" && candidates[j].b64 == ""
	})
	for _, c := range candidates {
		if view, err := c.read(); err == nil {
			return view, nil
		}
	}
	return ImageView{}, errNoImage()
}

// imageDistance orders the messages that name the same number (a session resumed numbers again from 1): the nearest
// to the time asked first, the earliest first when none was asked.
func imageDistance(messageAt int64, at int64) int64 {
	if at <= 0 {
		return messageAt
	}
	if messageAt > at {
		return messageAt - at
	}
	return at - messageAt
}

func (c imageCandidate) read() (ImageView, error) {
	if c.b64 != "" {
		if view, err := decodeImage(c.b64); err == nil || c.path == "" {
			return view, err
		}
	}
	return readImageFile(c.path)
}

// sniffImage tells the media type of image bytes by their signature, whatever their name or what the transcript says.
// Only the raster types a window shows; SVG, which may carry markup, is not one.
func sniffImage(data []byte) (string, bool) {
	switch mime := http.DetectContentType(data); mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
		return mime, true
	}
	return "", false
}

func decodeImage(b64 string) (ImageView, error) {
	if base64.StdEncoding.DecodedLen(len(b64)) > MaxImageBytes+3 {
		return ImageView{}, fmt.Errorf("the image is larger than %d bytes", MaxImageBytes)
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ImageView{}, fmt.Errorf("the image is not base64")
	}
	if len(data) > MaxImageBytes {
		return ImageView{}, fmt.Errorf("the image is larger than %d bytes", MaxImageBytes)
	}
	mime, ok := sniffImage(data)
	if !ok {
		return ImageView{}, fmt.Errorf("the data is not an image")
	}
	return ImageView{Mime: mime, Data: data}, nil
}

var imageExtensions = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true}

// readImageFile reads an image file the transcript records. The path is the transcript's word, so it is checked
// before it is opened: absolute, a regular file once its links are followed, an image extension and, read, an image
// signature, within MaxImageBytes.
func readImageFile(path string) (ImageView, error) {
	if path == "" || len(path) > MaxPathBytes || strings.ContainsRune(path, 0) || !filepath.IsAbs(path) {
		return ImageView{}, fmt.Errorf("not an absolute image path")
	}
	if !imageExtensions[strings.ToLower(filepath.Ext(path))] {
		return ImageView{}, fmt.Errorf("not an image file")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return ImageView{}, fmt.Errorf("image not found")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return ImageView{}, fmt.Errorf("the image is not a regular file")
	}
	if info.Size() > MaxImageBytes {
		return ImageView{}, fmt.Errorf("the image is larger than %d bytes", MaxImageBytes)
	}
	f, err := os.Open(resolved)
	if err != nil {
		return ImageView{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxImageBytes+1))
	if err != nil || len(data) > MaxImageBytes {
		return ImageView{}, fmt.Errorf("the image cannot be read")
	}
	mime, ok := sniffImage(data)
	if !ok {
		return ImageView{}, fmt.Errorf("the file is not an image")
	}
	return ImageView{Mime: mime, Data: data}, nil
}

// scanTranscript hands each line of a transcript to visit until it returns false. A line longer than imageLineMax is
// skipped whole, and no more than imageScanMax is read. The file is opened read-only, never through a link.
func scanTranscript(path string, visit func(line []byte) bool) error {
	li, err := os.Lstat(path)
	if err != nil || li.Mode()&os.ModeSymlink != 0 || !li.Mode().IsRegular() {
		return fmt.Errorf("not a regular session transcript")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	reader := bufio.NewReaderSize(io.LimitReader(f, imageScanMax), imageReadBuf)
	for {
		line, err := reader.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			line = readLongLine(reader, line)
			err = nil
		}
		if len(line) > 0 && !visit(bytes.TrimSpace(line)) {
			return nil
		}
		if err != nil {
			return nil
		}
	}
}

// readLongLine finishes a line that filled the reader's buffer: its text, or nil when it is longer than imageLineMax.
func readLongLine(reader *bufio.Reader, first []byte) []byte {
	line := append([]byte(nil), first...)
	for {
		more, err := reader.ReadSlice('\n')
		if len(line)+len(more) > imageLineMax {
			for err == bufio.ErrBufferFull {
				_, err = reader.ReadSlice('\n')
			}
			return nil
		}
		line = append(line, more...)
		if err != bufio.ErrBufferFull {
			return line
		}
	}
}

// imageNumbers reads the "[Image #N]" placeholders of a text, in order of appearance.
func imageNumbers(text string) []int {
	var rtn []int
	for _, m := range imagePlaceholderRegex.FindAllStringSubmatch(text, -1) {
		if n := atoiSafe(m[1]); n > 0 {
			rtn = append(rtn, n)
		}
	}
	return rtn
}
