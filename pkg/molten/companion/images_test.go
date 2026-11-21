// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Pasted images (#2455): the images of the transcripts below are invented and a few pixels wide, in the shape of what
// each agent writes.

func testPNG(t *testing.T, width, height int, c color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

var (
	red  = color.RGBA{R: 200, A: 255}
	blue = color.RGBA{B: 200, A: 255}
)

func b64(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

func jsonLine(t *testing.T, rec map[string]any) string {
	t.Helper()
	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func writeImageLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func imageBlock(data []byte) map[string]any {
	return map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": b64(data)}}
}

func claudeImageRecord(t *testing.T, uuid string, ts string, ids []int, text string, blocks ...map[string]any) string {
	t.Helper()
	content := []any{map[string]any{"type": "text", "text": text}}
	for _, b := range blocks {
		content = append(content, b)
	}
	rec := map[string]any{"type": "user", "uuid": uuid, "timestamp": ts, "message": map[string]any{"role": "user", "content": content}}
	if ids != nil {
		rec["imagePasteIds"] = ids
	}
	return jsonLine(t, rec)
}

func claudeSourceRecord(t *testing.T, parent string, paths ...string) string {
	t.Helper()
	var content []any
	for _, p := range paths {
		content = append(content, map[string]any{"type": "text", "text": "[Image: source: " + p + "]"})
	}
	return jsonLine(t, map[string]any{"type": "user", "isMeta": true, "uuid": parent + "-meta", "parentUuid": parent, "message": map[string]any{"role": "user", "content": content}})
}

func assertImage(t *testing.T, view ImageView, want []byte) {
	t.Helper()
	if view.Mime != "image/png" || !bytes.Equal(view.Data, want) {
		t.Fatalf("image: mime %q, %d bytes, want %d bytes", view.Mime, len(view.Data), len(want))
	}
}

func assertNoImage(t *testing.T, err error) {
	t.Helper()
	if text := uimsg.TextOf(err); err == nil || text == nil || text.Code != "companion.noimage" {
		t.Fatalf("want the no image error, got %v", err)
	}
}

func TestClaudeImageNumbersFollowImagePasteIds(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	first, second, third := testPNG(t, 2, 2, red), testPNG(t, 3, 1, blue), testPNG(t, 1, 4, red)
	writeImageLines(t, path,
		`{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-11-01T09:00:00.000Z"}`,
		claudeImageRecord(t, "u1", "2026-11-01T10:00:00.000Z", []int{3, 4}, "[Image #3] and [Image #4]", imageBlock(first), imageBlock(second)),
		claudeImageRecord(t, "u2", "2026-11-01T11:00:00.000Z", []int{5}, "[Image #5] again", imageBlock(third)),
	)
	a := MakeClaudeAdapter([]string{dir})
	for n, want := range map[int][]byte{3: first, 4: second, 5: third} {
		view, err := readSessionImage(a, path, n, 0)
		if err != nil {
			t.Fatalf("image %d: %v", n, err)
		}
		assertImage(t, view, want)
	}
	for _, n := range []int{1, 6, 0, -2} {
		_, err := readSessionImage(a, path, n, 0)
		assertNoImage(t, err)
	}
}

func TestClaudeImageOfTheMessageAsked(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	early, late := testPNG(t, 2, 2, red), testPNG(t, 3, 1, blue)
	// A session resumed numbers its images again from 1.
	writeImageLines(t, path,
		claudeImageRecord(t, "u1", "2026-11-01T10:00:00.000Z", []int{1}, "[Image #1]", imageBlock(early)),
		claudeImageRecord(t, "u2", "2026-11-02T10:00:00.000Z", []int{1}, "[Image #1]", imageBlock(late)),
	)
	a := MakeClaudeAdapter([]string{dir})
	view, err := readSessionImage(a, path, 1, parseTime("2026-11-02T10:00:00.000Z"))
	if err != nil {
		t.Fatal(err)
	}
	assertImage(t, view, late)
	view, err = readSessionImage(a, path, 1, parseTime("2026-11-01T10:00:05.000Z"))
	if err != nil {
		t.Fatal(err)
	}
	assertImage(t, view, early)
	view, err = readSessionImage(a, path, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	assertImage(t, view, early)
}

func TestClaudeImageFromTheRecordedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	pasted := testPNG(t, 4, 4, blue)
	file := filepath.Join(dir, "waveterm_paste_1795184150573_lzrg5z.png")
	if err := os.WriteFile(file, pasted, 0o600); err != nil {
		t.Fatal(err)
	}
	// The record's image block is gone; the meta record that follows it names the file.
	writeImageLines(t, path,
		claudeImageRecord(t, "u1", "2026-11-01T10:00:00.000Z", []int{7}, "[Image #7]"),
		claudeSourceRecord(t, "u1", file),
		claudeImageRecord(t, "u2", "2026-11-01T11:00:00.000Z", []int{8}, "[Image #8]"),
		claudeSourceRecord(t, "u2", filepath.Join(dir, "gone.png")),
	)
	a := MakeClaudeAdapter([]string{dir})
	view, err := readSessionImage(a, path, 7, 0)
	if err != nil {
		t.Fatal(err)
	}
	assertImage(t, view, pasted)
	_, err = readSessionImage(a, path, 8, 0)
	assertNoImage(t, err)
}

func TestClaudeImageFileOfAnotherKindIsNotServed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	secret := filepath.Join(dir, "notes.png")
	if err := os.WriteFile(secret, []byte("not an image, a secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeImageLines(t, path,
		claudeImageRecord(t, "u1", "2026-11-01T10:00:00.000Z", []int{1}, "[Image #1]"),
		claudeSourceRecord(t, "u1", secret),
	)
	_, err := readSessionImage(MakeClaudeAdapter([]string{dir}), path, 1, 0)
	assertNoImage(t, err)
}

func TestClaudeImageWithoutPasteIdsUsesTheMessageAsked(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	first, second := testPNG(t, 2, 2, red), testPNG(t, 3, 1, blue)
	ts := "2026-11-01T10:00:00.000Z"
	writeImageLines(t, path, claudeImageRecord(t, "u1", ts, nil, "two images", imageBlock(first), imageBlock(second)))
	a := MakeClaudeAdapter([]string{dir})
	view, err := readSessionImage(a, path, 2, parseTime(ts))
	if err != nil {
		t.Fatal(err)
	}
	assertImage(t, view, second)
	_, err = readSessionImage(a, path, 2, 0)
	assertNoImage(t, err)
	_, err = readSessionImage(a, path, 3, parseTime(ts))
	assertNoImage(t, err)
}

func TestClaudeImageScanSkipsAHugeLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	pasted := testPNG(t, 2, 2, red)
	huge := `{"type":"user","imagePasteIds":[2],"message":{"content":[{"type":"image","source":{"type":"base64","data":"` +
		strings.Repeat("A", imageLineMax+1024) + `"}}]}}`
	writeImageLines(t, path, huge, claudeImageRecord(t, "u1", "2026-11-01T10:00:00.000Z", []int{3}, "[Image #3]", imageBlock(pasted)))
	a := MakeClaudeAdapter([]string{dir})
	_, err := readSessionImage(a, path, 2, 0)
	assertNoImage(t, err)
	view, err := readSessionImage(a, path, 3, 0)
	if err != nil {
		t.Fatal(err)
	}
	assertImage(t, view, pasted)
}

func TestImageSizeAndKindAreChecked(t *testing.T) {
	if _, err := decodeImage("not base64 !"); err == nil {
		t.Fatal("text that is not base64 is not an image")
	}
	if _, err := decodeImage(b64([]byte("plain text"))); err == nil {
		t.Fatal("base64 of text is not an image")
	}
	svg := b64([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))
	if _, err := decodeImage(svg); err == nil {
		t.Fatal("an SVG is not served")
	}
	big := append(testPNG(t, 2, 2, red), make([]byte, MaxImageBytes)...)
	if _, err := decodeImage(b64(big)); err == nil {
		t.Fatal("an image over the cap is not served")
	}
}

func TestReadImageFileGuard(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.PNG")
	if err := os.WriteFile(good, testPNG(t, 2, 2, red), 0o600); err != nil {
		t.Fatal(err)
	}
	text := filepath.Join(dir, "text.png")
	if err := os.WriteFile(text, []byte("password=hunter2"), 0o600); err != nil {
		t.Fatal(err)
	}
	notImageName := filepath.Join(dir, "key.txt")
	if err := os.WriteFile(notImageName, testPNG(t, 2, 2, red), 0o600); err != nil {
		t.Fatal(err)
	}
	over := filepath.Join(dir, "over.png")
	f, err := os.Create(over)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(testPNG(t, 2, 2, red)); err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(MaxImageBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	folder := filepath.Join(dir, "folder.png")
	if err := os.Mkdir(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	linkToText := filepath.Join(dir, "link.png")
	linkToImage := filepath.Join(dir, "okay.png")
	if err := os.Symlink(text, linkToText); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if err := os.Symlink(good, linkToImage); err != nil {
		t.Fatal(err)
	}

	for name, path := range map[string]string{
		"relative":                   "waveterm_paste_1.png",
		"empty":                      "",
		"a nul in the path":          good + "\x00.png",
		"text with an image name":    text,
		"an image with another name": notImageName,
		"over the cap":               over,
		"a folder":                   folder,
		"a link to text":             linkToText,
		"missing":                    filepath.Join(dir, "missing.png"),
		"outside the temp root":      "/etc/passwd",
	} {
		if view, err := readImageFile(path); err == nil {
			t.Errorf("%s: served %d bytes", name, len(view.Data))
		}
	}
	for name, path := range map[string]string{"an image": good, "a link to an image": linkToImage} {
		view, err := readImageFile(path)
		if err != nil || view.Mime != "image/png" {
			t.Errorf("%s: %v %q", name, err, view.Mime)
		}
	}
}

func TestImageRequestNamesNoPath(t *testing.T) {
	typ := reflect.TypeOf(imageRequest{})
	for i := 0; i < typ.NumField(); i++ {
		switch typ.Field(i).Name {
		case "BlockId", "N", "At":
		default:
			t.Fatalf("an image request carries %s: the window must never name a file", typ.Field(i).Name)
		}
	}
}

func TestWatcherImage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	pasted := testPNG(t, 2, 2, blue)
	writeImageLines(t, path, claudeImageRecord(t, "u1", "2026-11-01T10:00:00.000Z", []int{2}, "[Image #2]", imageBlock(pasted)))
	w := &watcher{adapter: MakeClaudeAdapter([]string{dir}), path: path, session: MakeSession()}
	view, err := w.image(2, 0)
	if err != nil {
		t.Fatal(err)
	}
	assertImage(t, view, pasted)
	_, err = w.image(1, 0)
	assertNoImage(t, err)
	w.session = nil
	if _, err := w.image(2, 0); uimsg.TextOf(err).Code != "companion.nosession" {
		t.Fatalf("no session: %v", err)
	}
	m := MakeManager()
	if _, err := m.Image("nobody", 1, 0); uimsg.TextOf(err).Code != "companion.notopen" {
		t.Fatalf("a closed companion: %v", err)
	}
}

// The window's request as the route gets it (JSON numbers are floats) and the answer as the window reads it: the
// image's bytes as base64 under "data", with their type.
func TestImageCommandThroughTheRoute(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	pasted := testPNG(t, 2, 3, red)
	writeImageLines(t, path, claudeImageRecord(t, "u1", "2026-11-01T10:00:00.000Z", []int{4}, "[Image #4]", imageBlock(pasted)))
	m := MakeManager()
	m.watchers["b1"] = &watcher{adapter: MakeClaudeAdapter([]string{dir}), path: path, session: MakeSession()}
	l := &routeLink{m: m}
	var request map[string]any
	if err := json.Unmarshal([]byte(`{"blockid":"b1","n":4,"at":1792000000000}`), &request); err != nil {
		t.Fatal(err)
	}
	result, err := l.handle(molten.CompanionImageCommand, localroute.Caller{IsWindow: true}, request)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Mime string `json:"mime"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(wire, &got); err != nil {
		t.Fatal(err)
	}
	if got.Mime != "image/png" || got.Data != b64(pasted) {
		t.Fatalf("on the wire: mime %q, %d characters of data, want %d", got.Mime, len(got.Data), len(b64(pasted)))
	}
	request["n"] = float64(5)
	if _, err := l.handle(molten.CompanionImageCommand, localroute.Caller{IsWindow: true}, request); uimsg.TextOf(err).Code != "companion.noimage" {
		t.Fatalf("an image the transcript does not hold: %v", err)
	}
	request["blockid"] = "b2"
	if _, err := l.handle(molten.CompanionImageCommand, localroute.Caller{IsWindow: true}, request); uimsg.TextOf(err).Code != "companion.notopen" {
		t.Fatalf("a companion that is not open: %v", err)
	}
}

func codexMessageEvent(t *testing.T, ts string, payload map[string]any) string {
	t.Helper()
	return jsonLine(t, map[string]any{"timestamp": ts, "type": "event_msg", "payload": payload})
}

func TestCodexImages(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout.jsonl")
	inline, file, remote := testPNG(t, 2, 2, red), testPNG(t, 3, 1, blue), testPNG(t, 1, 4, red)
	local := filepath.Join(dir, "shot.png")
	if err := os.WriteFile(local, file, 0o600); err != nil {
		t.Fatal(err)
	}
	dataURL := func(data []byte) string { return "data:image/png;base64," + b64(data) }
	writeImageLines(t, path,
		jsonLine(t, map[string]any{"timestamp": "2026-11-01T10:00:00.000Z", "type": "response_item", "payload": map[string]any{
			"type": "message", "role": "user", "content": []any{
				map[string]any{"type": "input_text", "text": "<image name=[Image #1]>"},
				map[string]any{"type": "input_image", "image_url": dataURL(inline)},
				map[string]any{"type": "input_text", "text": "</image>"},
				map[string]any{"type": "input_text", "text": "look at [Image #1]"},
			},
		}}),
		codexMessageEvent(t, "2026-11-01T11:00:00.000Z", map[string]any{
			"type": "item_completed", "item": map[string]any{"type": "UserMessage", "content": []any{
				map[string]any{"type": "text", "text": "compare [Image #2] with [Image #3]"},
				map[string]any{"type": "local_image", "path": local},
				map[string]any{"type": "image", "image_url": dataURL(remote)},
			}},
		}),
		codexMessageEvent(t, "2026-11-01T12:00:00.000Z", map[string]any{
			"type": "user_message", "message": "[Image #4] too", "local_images": []any{filepath.Join(dir, "gone.png")},
		}),
	)
	a := MakeCodexAdapter([]string{dir})
	for n, want := range map[int][]byte{1: inline, 2: file, 3: remote} {
		view, err := readSessionImage(a, path, n, 0)
		if err != nil {
			t.Fatalf("image %d: %v", n, err)
		}
		assertImage(t, view, want)
	}
	for _, n := range []int{4, 5} {
		_, err := readSessionImage(a, path, n, 0)
		assertNoImage(t, err)
	}
}

func kimiMessage(t *testing.T, time int64, parts ...map[string]any) string {
	t.Helper()
	content := make([]any, 0, len(parts))
	for _, p := range parts {
		content = append(content, p)
	}
	return jsonLine(t, map[string]any{"type": "context.append_message", "time": time, "agentId": "main", "message": map[string]any{
		"role": "user", "origin": map[string]any{"kind": "user"}, "content": content, "toolCalls": []any{},
	}})
}

func kimiImagePart(url string) map[string]any {
	return map[string]any{"type": "image_url", "imageUrl": map[string]any{"url": url}}
}

func TestKimiImages(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wire.jsonl")
	first := testPNG(t, 2, 2, red)
	writeImageLines(t, path,
		kimiMessage(t, 1795041015665, map[string]any{"type": "text", "text": "see "}, kimiImagePart("data:image/png;base64,"+b64(first))),
		kimiMessage(t, 1795041015666, kimiImagePart("kimi-file://f_1234")),
		jsonLine(t, map[string]any{"type": "context.append_message", "time": 1795041015667, "message": map[string]any{
			"role": "user", "origin": map[string]any{"kind": "injection"}, "content": []any{kimiImagePart("data:image/png;base64," + b64(first))},
		}}),
	)
	a := MakeKimiAdapter([]string{dir})
	view, err := readSessionImage(a, path, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	assertImage(t, view, first)
	for _, n := range []int{2, 3} {
		_, err := readSessionImage(a, path, n, 0)
		assertNoImage(t, err)
	}
}

func TestKimiMessageNamesItsImages(t *testing.T) {
	a := MakeKimiAdapter([]string{"/nowhere"})
	s := MakeSession()
	record := func(parts ...map[string]any) map[string]any {
		content := make([]any, 0, len(parts))
		for _, p := range parts {
			content = append(content, p)
		}
		return map[string]any{"type": "context.append_message", "time": float64(1795041015665), "message": map[string]any{
			"role": "user", "origin": map[string]any{"kind": "user"}, "content": content,
		}}
	}
	text := func(s string) map[string]any { return map[string]any{"type": "text", "text": s} }
	a.Parse(record(text("compare"), kimiImagePart("data:image/png;base64,AAAA"), text("with"), kimiImagePart("kimi-file://x")), s)
	a.Parse(record(kimiImagePart("kimi-file://y")), s)
	a.Parse(record(text("and "), kimiImagePart("kimi-file://z")), s)
	var got []string
	for _, p := range s.prompts {
		got = append(got, p.Text)
	}
	want := []string{"compare [Image #1] with [Image #2]", "and [Image #4]"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("prompts: got %q, want %q", got, want)
	}
}

func TestKimiImagesOfAFollowedTailAreNotGiven(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wire.jsonl")
	writeImageLines(t, path, kimiMessage(t, 1795041015665, kimiImagePart("data:image/png;base64,"+b64(testPNG(t, 2, 2, red)))))
	if err := os.Truncate(path, tailFullReadMax+1); err != nil {
		t.Fatal(err)
	}
	_, err := readSessionImage(MakeKimiAdapter([]string{dir}), path, 1, 0)
	assertNoImage(t, err)
}
