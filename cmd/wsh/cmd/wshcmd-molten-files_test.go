// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/filesearch"
)

type fakeFilesClient struct {
	show    filesearch.ShowResult
	showErr error
	answers []string
	asked   int
	req     filesearch.ShowRequest
}

func (c *fakeFilesClient) Show(req filesearch.ShowRequest) (filesearch.ShowResult, error) {
	c.req = req
	return c.show, c.showErr
}

func (c *fakeFilesClient) Answer(req filesearch.AnswerRequest) (filesearch.AnswerResult, error) {
	state := c.answers[c.asked]
	c.asked++
	return filesearch.AnswerResult{State: state}, nil
}

func isFilesUsage(err error) bool {
	var usage moltenFilesUsageError
	return errors.As(err, &usage)
}

func TestParseMoltenFilesArgs(t *testing.T) {
	cwd := filepath.FromSlash("/work/project")
	got, err := parseMoltenFilesArgs([]string{"src"}, "test", true, true, cwd)
	if err != nil || got.req.Folder != filepath.Join(cwd, "src") || got.req.Pattern != "test" || !got.req.Recursive || !got.json {
		t.Fatalf("relative folder: %+v %v", got, err)
	}
	abs := filepath.Join(cwd, "other")
	if got, _ := parseMoltenFilesArgs([]string{abs + string(filepath.Separator)}, "", false, false, cwd); got.req.Folder != abs {
		t.Fatalf("absolute folder: %q", got.req.Folder)
	}
	if got, _ := parseMoltenFilesArgs(nil, "", false, false, cwd); got.req.Folder != "" || got.req.Cwd != cwd {
		t.Fatalf("no folder: wavesrv uses the workspace folder: %+v", got.req)
	}
	for name, args := range map[string]struct {
		args      []string
		filter    string
		recursive bool
	}{
		"two folders":       {[]string{"a", "b"}, "", false},
		"control character": {nil, "a\tb", false},
		"too long":          {nil, strings.Repeat("x", filesearch.MaxPatternLen+1), false},
		"bad glob":          {nil, "[ab", false},
		"recursive alone":   {nil, "", true},
		"empty folder":      {[]string{""}, "", false},
	} {
		if _, err := parseMoltenFilesArgs(args.args, args.filter, args.recursive, false, cwd); !isFilesUsage(err) {
			t.Errorf("%s: %v, want bad usage", name, err)
		}
	}
	if _, err := parseMoltenFilesArgs([]string{"src"}, "", false, false, ""); err == nil || isFilesUsage(err) {
		t.Fatalf("an unknown working directory is a failure, not bad usage: %v", err)
	}
}

func sampleFilesResult() filesearch.ShowResult {
	return filesearch.ShowResult{
		Panel:   "panel",
		Folder:  "/work/project/src",
		Pattern: "test",
		Matches: []filesearch.Match{
			{Name: "tests", Path: "/work/project/src/tests", IsDir: true},
			{Name: "linked", Path: "/work/project/src/linked", MimeType: "directory"},
			{Name: "a.test.ts", Path: "/work/project/src/a.test.ts"},
		},
	}
}

func TestMoltenFilesTextOutput(t *testing.T) {
	r := sampleFilesResult()
	want := "tests/\nlinked/\na.test.ts\n3 matches in /work/project/src\n"
	if got := formatMoltenFilesText(r); got != want {
		t.Fatalf("text:\n%s\nwant:\n%s", got, want)
	}
	r.Matches, r.Truncated = nil, false
	if got := formatMoltenFilesText(r); got != "0 matches in /work/project/src\n" {
		t.Fatalf("zero matches: %q", got)
	}
	r.Truncated = true
	if got := formatMoltenFilesText(r); !strings.HasPrefix(got, "0 matches in /work/project/src (truncated") {
		t.Fatalf("truncated: %q", got)
	}
}

func TestMoltenFilesJsonOutput(t *testing.T) {
	var out bytes.Buffer
	r := sampleFilesResult()
	r.Recursive = true
	if err := writeMoltenFilesResult(&out, r, true); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["folder"] != "/work/project/src" || got["pattern"] != "test" || got["recursive"] != true || got["truncated"] != false {
		t.Fatalf("json %v", got)
	}
	matches := got["matches"].([]any)
	first := matches[0].(map[string]any)
	last := matches[2].(map[string]any)
	if len(matches) != 3 || first["path"] != "tests" || first["type"] != "dir" || last["type"] != "file" || len(first) != 2 {
		t.Fatalf("matches %v", matches)
	}
	out.Reset()
	r.Matches = nil
	_ = writeMoltenFilesResult(&out, r, true)
	if !strings.Contains(out.String(), `"matches": []`) {
		t.Fatalf("zero matches is an empty list: %s", out.String())
	}
}

func TestRunMoltenFilesWaitsForTheAnswer(t *testing.T) {
	r := sampleFilesResult()
	r.Asked = true
	client := &fakeFilesClient{show: r, answers: []string{filesearch.AnswerWaiting, filesearch.AnswerWaiting, filesearch.AnswerApproved}}
	var out, errOut bytes.Buffer
	if err := runMoltenFiles(moltenFilesArgs{}, client, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if client.asked != 3 || !strings.HasSuffix(out.String(), "3 matches in /work/project/src\n") || !strings.Contains(errOut.String(), "waiting for the user") {
		t.Fatalf("approved: %d answers, out %q, err %q", client.asked, out.String(), errOut.String())
	}
	client = &fakeFilesClient{show: r, answers: []string{filesearch.AnswerStayed}}
	out.Reset()
	err := runMoltenFiles(moltenFilesArgs{}, client, &out, &errOut)
	if err == nil || err.Error() != MoltenFilesStayedMessage || isFilesUsage(err) || out.Len() != 0 {
		t.Fatalf("stayed: %v, out %q", err, out.String())
	}
	client = &fakeFilesClient{show: r, answers: []string{filesearch.AnswerClosed}}
	if err := runMoltenFiles(moltenFilesArgs{}, client, &out, &errOut); err == nil || err.Error() != MoltenFilesClosedMessage {
		t.Fatalf("closed: %v", err)
	}
}

func TestRunMoltenFilesErrors(t *testing.T) {
	var out, errOut bytes.Buffer
	client := &fakeFilesClient{showErr: errors.New("the folder /x does not exist")}
	if err := runMoltenFiles(moltenFilesArgs{}, client, &out, &errOut); err == nil || isFilesUsage(err) {
		t.Fatalf("a failure: %v", err)
	}
	client = &fakeFilesClient{showErr: errors.New("bad pattern: the pattern holds a control character")}
	if err := runMoltenFiles(moltenFilesArgs{}, client, &out, &errOut); !isFilesUsage(err) {
		t.Fatalf("wavesrv's pattern refusal is bad usage: %v", err)
	}
}

func TestMoltenFilesFailExitCodes(t *testing.T) {
	saved := WshExitCode
	t.Cleanup(func() { WshExitCode = saved })
	moltenFilesFail(moltenFilesUsageError{msg: "too many arguments"})
	if WshExitCode != 2 {
		t.Fatalf("bad usage: exit %d", WshExitCode)
	}
	WshExitCode = 0
	moltenFilesFail(errors.New(MoltenFilesStayedMessage))
	if WshExitCode != 1 {
		t.Fatalf("other failures: exit %d", WshExitCode)
	}
}
