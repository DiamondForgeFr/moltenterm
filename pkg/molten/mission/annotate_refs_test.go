// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/materials"
)

// A zone's comment may carry reference images and links (FR-BRW-017 AC21, AC22, #2327).

func annotateJpegBytes(t *testing.T, w int, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.NRGBA{R: uint8(x * 5), G: uint8(y * 5), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func refDataURL(mime string, raw []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
}

// requestWithRefs: a request whose zones are the ones given, comments and reference images.
func (f *annotateFixture) requestWithRefs(action string, zones ...AnnotateZone) AnnotateRequest {
	req := f.request(action, "x")
	req.Zones = zones
	return req
}

// Reference images are kept like the capture: decoded, written again, a material of the project each, listed in the
// brief by their copy's path as "zone N, reference M" with the sentence that says they are examples; nothing is
// written in the project.
func TestAnnotateReferencesAreKeptAsMaterialsAndListed(t *testing.T) {
	t.Parallel()
	f := makeAnnotateFixture(t)
	req := f.requestWithRefs(AnnotateCopy,
		AnnotateZone{Comment: "Like this.", Images: []string{
			refDataURL("image/png", annotatePngBytes(t, 50, 30)),
			refDataURL("image/jpeg", annotateJpegBytes(t, 40, 40)),
		}},
		AnnotateZone{Comment: "And this.", Images: []string{refDataURL("image/png", annotatePngBytes(t, 52, 32))}},
	)
	req.RefTitle = "Zone {zone}, reference {n}"
	got, err := runAnnotate(context.Background(), f.env, req)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.References) != 2 || len(got.References[0]) != 2 || len(got.References[1]) != 1 {
		t.Fatalf("references %v", got.References)
	}
	dataDir := filepath.Join(f.data, "molten", "materials") + string(filepath.Separator)
	exts := []string{".png", ".jpg", ".png"}
	n := 0
	for z, paths := range got.References {
		for r, path := range paths {
			if !strings.HasPrefix(path, dataDir) || filepath.Ext(path) != exts[n] {
				t.Errorf("reference %d.%d: %q", z+1, r+1, path)
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := image.Decode(bytes.NewReader(raw)); err != nil {
				t.Errorf("reference %d.%d does not decode: %v", z+1, r+1, err)
			}
			want := fmt.Sprintf("- **Comment %d, reference %d:** `%s`", z+1, r+1, path)
			if !strings.Contains(got.Text, want) {
				t.Errorf("the brief does not list %s:\n%s", want, got.Text)
			}
			n++
		}
	}
	if !strings.Contains(got.Text, annotateRefsNote) {
		t.Errorf("the brief does not say the references are examples:\n%s", got.Text)
	}
	key, _ := materials.ProjectKey(f.checkout)
	list, err := f.registry.Store().List(key)
	if err != nil || len(list) != 4 {
		t.Fatalf("the project's materials: %d (%v)", len(list), err)
	}
	titles := map[string]bool{}
	for _, m := range list {
		titles[m.Title] = true
	}
	for _, title := range []string{"Zone 1, reference 1", "Zone 1, reference 2", "Zone 2, reference 1"} {
		if !titles[title] {
			t.Errorf("no material titled %q among %v", title, titles)
		}
	}
	if entries, _ := os.ReadDir(f.checkout); len(entries) != 1 || entries[0].Name() != ".git" {
		t.Errorf("something was written in the project: %v", entries)
	}
	if entries, _ := os.ReadDir(f.tmp); len(entries) != 0 {
		t.Errorf("the temporary folder holds %v", entries)
	}
}

// A send hands the references to the agent in the same brief, with the capture, and the typed goal names none.
func TestAnnotateSendListsTheReferencesInTheBrief(t *testing.T) {
	t.Parallel()
	f := makeAnnotateFixture(t)
	req := f.requestWithRefs(AnnotateSend, AnnotateZone{Comment: "Like this.", Images: []string{refDataURL("image/png", annotatePngBytes(t, 50, 30))}})
	req.To = AnnotateRecipient{BlockId: "block-camille", FirstName: "Camille"}
	req.WorkspaceId = "ws-1"
	got, err := runAnnotate(context.Background(), f.env, req)
	if err != nil || got.Status != AnnotateStatusSent || len(got.References) != 1 {
		t.Fatalf("got %+v, %v", got, err)
	}
	if !strings.Contains(f.sent[0].Context, got.References[0][0]) || !strings.Contains(f.sent[0].Context, "Comment 1, reference 1") {
		t.Errorf("the brief:\n%s", f.sent[0].Context)
	}
	if strings.Contains(f.sent[0].Goal, "reference") {
		t.Errorf("the typed goal names the references: %s", f.sent[0].Goal)
	}
}

// The reference is decoded and written again, in its own format: what the bytes held besides the picture is not kept.
func TestAnnotateReferenceIsWrittenAgain(t *testing.T) {
	t.Parallel()
	f := makeAnnotateFixture(t)
	req := f.requestWithRefs(AnnotateCopy, AnnotateZone{Comment: "x", Images: []string{
		refDataURL("image/png", append(annotatePngBytes(t, 30, 20), []byte("<script>trailing</script>")...)),
		refDataURL("image/jpeg", append(annotateJpegBytes(t, 30, 20), []byte("<script>trailing</script>")...)),
	}})
	got, err := runAnnotate(context.Background(), f.env, req)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range got.References[0] {
		raw, err := os.ReadFile(path)
		if err != nil || bytes.Contains(raw, []byte("trailing")) {
			t.Errorf("%s holds the trailing bytes (%v)", path, err)
		}
	}
}

// The same guards as the capture: the size before decoding, the format, the dimensions; and a refusal keeps nothing.
func TestAnnotateReferenceGuards(t *testing.T) {
	t.Parallel()
	f := makeAnnotateFixture(t)
	huge := "data:image/png;base64," + strings.Repeat("A", annotateMaxRefBytes*4/3+64)
	cases := map[string]string{
		"a GIF":                       refDataURL("image/gif", []byte("GIF89a")),
		"a WebP":                      refDataURL("image/webp", []byte("RIFF....WEBPVP8 ")),
		"an SVG":                      refDataURL("image/svg+xml", []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")),
		"no data URL":                 "https://example.test/a.png",
		"a path":                      "/etc/passwd",
		"bad base64":                  "data:image/png;base64,!!!not base64!!!",
		"nothing":                     "data:image/png;base64,",
		"text called a PNG":           refDataURL("image/png", []byte("hello")),
		"a JPEG called a PNG":         refDataURL("image/png", annotateJpegBytes(t, 10, 10)),
		"a PNG called a JPEG":         refDataURL("image/jpeg", annotatePngBytes(t, 10, 10)),
		"too large before decoding":   huge,
		"too many bytes once decoded": refDataURL("image/png", append(annotatePngBytes(t, 10, 10), make([]byte, annotateMaxRefBytes)...)),
		"too wide":                    refDataURL("image/png", annotatePngBytes(t, annotateMaxRefSide+1, 2)),
		"too many pixels":             refDataURL("image/png", annotatePngBytes(t, 3100, 3100)),
	}
	for name, data := range cases {
		req := f.requestWithRefs(AnnotateCopy, AnnotateZone{Comment: "x", Images: []string{data}})
		if _, err := runAnnotate(context.Background(), f.env, req); err == nil {
			t.Errorf("%s: no refusal", name)
		}
	}
	if f.kept != 0 {
		t.Errorf("a refused request kept %d", f.kept)
	}
	for _, name := range []string{"too wide", "too many pixels"} {
		req := f.requestWithRefs(AnnotateCopy, AnnotateZone{Comment: "x", Images: []string{cases[name]}})
		if _, err := runAnnotate(context.Background(), f.env, req); err == nil || !strings.Contains(err.Error(), "no usable size") {
			t.Errorf("%s was not refused for its size: %v", name, err)
		}
	}
	if _, err := runAnnotate(context.Background(), f.env, f.requestWithRefs(AnnotateCopy, AnnotateZone{Comment: "x", Images: []string{huge}})); err == nil ||
		!strings.HasSuffix(err.Error(), "a reference image is too large") {
		t.Errorf("a payload over the limit was not refused for its size before decoding: %v", err)
	}
	// One bad reference among good ones keeps none of them.
	req := f.requestWithRefs(AnnotateCopy, AnnotateZone{Comment: "x", Images: []string{
		refDataURL("image/png", annotatePngBytes(t, 10, 10)), "data:image/png;base64,AAAA",
	}})
	if _, err := runAnnotate(context.Background(), f.env, req); err == nil || f.kept != 0 {
		t.Errorf("a bad reference among good ones: %v, kept %d", err, f.kept)
	}
	if entries, _ := os.ReadDir(f.tmp); len(entries) != 0 {
		t.Errorf("the temporary folder holds %v", entries)
	}
}

// A zone holds at most four references, a report eight: a preview asks the same with the counts it is given.
func TestAnnotateReferenceLimits(t *testing.T) {
	t.Parallel()
	f := makeAnnotateFixture(t)
	one := refDataURL("image/png", annotatePngBytes(t, 8, 8))
	many := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = one
		}
		return out
	}
	if _, err := runAnnotate(context.Background(), f.env, f.requestWithRefs(AnnotateCopy, AnnotateZone{Comment: "x", Images: many(annotateMaxRefsPerZone)})); err != nil {
		t.Fatalf("the limit itself was refused: %v", err)
	}
	if _, err := runAnnotate(context.Background(), f.env, f.requestWithRefs(AnnotateCopy, AnnotateZone{Comment: "x", Images: many(annotateMaxRefsPerZone + 1)})); err == nil {
		t.Error("five references in a zone")
	}
	zones := []AnnotateZone{{Images: many(4)}, {Images: many(4)}, {Images: many(1)}}
	if _, err := runAnnotate(context.Background(), f.env, f.requestWithRefs(AnnotateCopy, zones...)); err == nil {
		t.Error("nine references in a report")
	}
	if _, err := runAnnotate(context.Background(), f.env, f.requestWithRefs(AnnotatePreview, AnnotateZone{ImageCount: 5})); err == nil {
		t.Error("a preview of five references in a zone")
	}
}

// The review's preview lists the references the same way, naming the images it shows, with the same sentence; no path
// is invented, and nothing is kept.
func TestAnnotatePreviewListsTheReferences(t *testing.T) {
	t.Parallel()
	f := makeAnnotateFixture(t)
	got, err := runAnnotate(context.Background(), f.env, f.requestWithRefs(AnnotatePreview, AnnotateZone{Comment: "x", ImageCount: 2}))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"**Comment 1, reference 1:** the image shown in the review", "**Comment 1, reference 2:** the image shown in the review", annotateRefsNote} {
		if !strings.Contains(got.Text, want) {
			t.Errorf("the preview does not say %q:\n%s", want, got.Text)
		}
	}
	if f.kept != 0 {
		t.Errorf("a preview kept %d", f.kept)
	}
}

// Only http and https addresses are links; anything else stays plain text, which the comment keeps in any case.
func TestAnnotateLinks(t *testing.T) {
	t.Parallel()
	cases := map[string][]string{
		"see https://example.test/a and http://example.test/b": {"https://example.test/a", "http://example.test/b"},
		"(like https://example.test/a).":                       {"https://example.test/a"},
		"https://en.example.test/wiki/Go_(language) works":     {"https://en.example.test/wiki/Go_(language)"},
		"HTTPS://Example.test/A, nice!":                        {"https://Example.test/A"},
		"twice https://example.test/a https://example.test/a":  {"https://example.test/a"},
		"javascript:alert(1)":                                  nil,
		"file:///etc/passwd":                                   nil,
		"data:text/html,<script>alert(1)</script>":             nil,
		"ftp://example.test/a":                                 nil,
		"mailto:someone@example.test":                          nil,
		"chrome://settings":                                    nil,
		"http:///nohost":                                       nil,
		"https://":                                             nil,
		"xhttps://example.test/a":                              nil,
		"no link here, only example.test/a":                    nil,
		"https://user:secret@example.test/p?q=1#frag":          {"https://example.test/p?q=1"},
		"https://example.test/p?access_token=abc&page=2":       {"https://example.test/p?page=2"},
		"https://example.test/p?X-Amz-Signature=abc&a=1":       {"https://example.test/p"},
	}
	for comment, want := range cases {
		got := annotateLinks(comment)
		if len(got) != len(want) {
			t.Errorf("%q: %v, want %v", comment, got, want)
			continue
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("%q: %v, want %v", comment, got, want)
			}
		}
	}
	var many []string
	for i := 0; i < 9; i++ {
		many = append(many, fmt.Sprintf("https://example.test/%d", i))
	}
	if got := annotateLinks(strings.Join(many, " ")); len(got) != annotateMaxLinksPerZone {
		t.Errorf("%d links, want at most %d", len(got), annotateMaxLinksPerZone)
	}
}

// The window's chips and this listing split a comment the same way: both read the same fixtures
// (testdata/annotate-links.json; annotate-model.test.ts reads them too), Unicode spaces and invisible characters included.
func TestAnnotateLinksSplitAsTheWindowDoes(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile(filepath.Join("testdata", "annotate-links.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name    string   `json:"name"`
		Comment string   `json:"comment"`
		Hosts   []string `json:"hosts"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 15 {
		t.Fatalf("only %d fixtures", len(cases))
	}
	for _, c := range cases {
		var hosts []string
		for _, link := range annotateLinks(annotateBlock(c.Comment, annotateMaxCommentRunes)) {
			u, err := url.Parse(link)
			if err != nil {
				t.Fatalf("%s: %q: %v", c.Name, link, err)
			}
			hosts = append(hosts, strings.ToLower(u.Host))
		}
		if strings.Join(hosts, ",") != strings.Join(c.Hosts, ",") {
			t.Errorf("%s: %q gave %v, want %v", c.Name, c.Comment, hosts, c.Hosts)
		}
	}
}

// A preview, a copy and a send answer each zone's links as the brief lists them, so that the review shows the brief's.
func TestAnnotateAnswersTheLinksItLists(t *testing.T) {
	t.Parallel()
	f := makeAnnotateFixture(t)
	for _, action := range []string{AnnotatePreview, AnnotateCopy} {
		got, err := runAnnotate(context.Background(), f.env, f.request(action, "Like https://a.test/x?token=abc&p=1", "plain", "see javascript:alert(1)"))
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Links) != 3 || len(got.Links[0]) != 1 || got.Links[0][0] != "https://a.test/x?p=1" || len(got.Links[1]) != 0 || len(got.Links[2]) != 0 {
			t.Errorf("%s: links %v", action, got.Links)
		}
		if !strings.Contains(got.Text, "- `https://a.test/x?p=1`") {
			t.Errorf("%s: the brief does not list what was answered:\n%s", action, got.Text)
		}
	}
	none, err := runAnnotate(context.Background(), f.env, f.request(AnnotatePreview, "a plain comment"))
	if err != nil || none.Links != nil {
		t.Errorf("links %v (%v), want none", none.Links, err)
	}
}

// The brief lists a zone's links under it, keeps them in the comment's text, and says linked pages are examples; a
// comment with only addresses that are no links lists none and says nothing of examples.
func TestAnnotateBriefListsLinks(t *testing.T) {
	t.Parallel()
	f := makeAnnotateFixture(t)
	got, err := runAnnotate(context.Background(), f.env, f.request(AnnotateCopy, "Like https://example.test/inspiration please", "see javascript:alert(1) or file:///etc/passwd"))
	if err != nil {
		t.Fatal(err)
	}
	blocks, outside := fencedComments(got.Text)
	if len(blocks) != 2 || blocks[0] != "Like https://example.test/inspiration please" {
		t.Errorf("the comments' text changed: %q", blocks)
	}
	if strings.Count(got.Text, "**Links**") != 1 || !strings.Contains(outside, "- `https://example.test/inspiration`") {
		t.Errorf("the links:\n%s", got.Text)
	}
	if !strings.Contains(got.Text, annotateRefsNote) {
		t.Errorf("the brief does not say linked pages are examples:\n%s", got.Text)
	}
	plain, err := runAnnotate(context.Background(), f.env, f.request(AnnotateCopy, "see javascript:alert(1) or file:///etc/passwd"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain.Text, "**Links**") || strings.Contains(plain.Text, annotateRefsNote) || strings.Contains(plain.Text, "- `javascript") {
		t.Errorf("addresses that are no links were listed:\n%s", plain.Text)
	}
	none, err := runAnnotate(context.Background(), f.env, f.request(AnnotateCopy, "A plain comment."))
	if err != nil || strings.Contains(none.Text, annotateRefsNote) || strings.Contains(none.Text, "reference") {
		t.Errorf("a report with no reference says so: %v\n%s", err, none.Text)
	}
}
