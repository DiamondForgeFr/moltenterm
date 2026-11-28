// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/spf13/pflag"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// What `molten browser` sends to wavesrv and prints back, with wavesrv played by a function. They change the command's
// output, its exit code and its flags, which are the program's own: they run one after the other, not in parallel.

type browserRun struct {
	t        *testing.T
	out      *bytes.Buffer
	errOut   *bytes.Buffer
	requests []mcpbrowser.CliRequest
	// answer plays wavesrv: the result of each call, or a link error.
	answer func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error)
}

func startBrowserRun(t *testing.T, answer func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error)) *browserRun {
	t.Helper()
	run := &browserRun{t: t, out: &bytes.Buffer{}, errOut: &bytes.Buffer{}, answer: answer}
	t.Setenv(wshutil.WaveJwtTokenVarName, "tok-test")
	oldOut, oldErr, oldSend, oldJson, oldExit := WrappedStdout, WrappedStderr, moltenBrowserSend, moltenJson, WshExitCode
	WrappedStdout, WrappedStderr = run.out, run.errOut
	moltenJson, WshExitCode = false, 0
	moltenBrowserSend = func(command string, data any, opts *wshrpc.RpcOpts) (any, error) {
		if command != mcpbrowser.CliCommand || opts.Route != mcpbrowser.RouteId || opts.Timeout < 190000 {
			t.Errorf("a call goes to the browser route's command line command, and waits for a site question: %s %+v", command, opts)
		}
		req, ok := data.(mcpbrowser.CliRequest)
		if !ok {
			t.Fatalf("the request is a CliRequest: %T", data)
		}
		run.requests = append(run.requests, req)
		result, err := run.answer(req)
		if err != nil {
			return nil, err
		}
		return result, nil
	}
	t.Cleanup(func() {
		WrappedStdout, WrappedStderr, moltenBrowserSend, moltenJson, WshExitCode = oldOut, oldErr, oldSend, oldJson, oldExit
	})
	return run
}

// run executes `molten browser <words...>` as the program does: the flags are parsed, then the command runs.
func (r *browserRun) run(words ...string) {
	r.t.Helper()
	cmd := moltenCommandByWords("browser " + words[0])
	if cmd == nil {
		r.t.Fatalf("no command %q", words[0])
	}
	cmd.Flags().VisitAll(func(f *pflag.Flag) { f.Value.Set(f.DefValue); f.Changed = false })
	if err := cmd.ParseFlags(words[1:]); err != nil {
		r.t.Fatalf("flags %v: %v", words, err)
	}
	args := cmd.Flags().Args()
	if err := cmd.Args(cmd, args); err != nil {
		r.t.Fatalf("args %v: %v", words, err)
	}
	if err := cmd.RunE(cmd, args); err != nil {
		r.t.Fatalf("RunE: %v", err)
	}
}

func (r *browserRun) tools() []string {
	var rtn []string
	for _, req := range r.requests {
		rtn = append(rtn, req.Tool+" "+string(req.Args))
	}
	return rtn
}

func TestBrowserReadSendsTheTerminalsTokenAndPrintsThePageInsideItsNotice(t *testing.T) {
	page := mcpbrowser.UntrustedNotice + "\n<untrusted-page-content site=\"docs.example\">\nTitle: Guide\n\nHello\n</untrusted-page-content>"
	run := startBrowserRun(t, func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error) {
		return mcpbrowser.TextResult(`{"tabId":3,"site":"docs.example","source":"main","truncated":false}` + "\n" + page), nil
	})
	run.run("read", "3")
	if got := strings.Join(run.tools(), "|"); got != `get_page_text {"tabId":3}` {
		t.Fatalf("requests: %s", got)
	}
	if run.requests[0].Token != "tok-test" {
		t.Fatalf("the terminal's own token goes with the call, and nothing else names the terminal: %q", run.requests[0].Token)
	}
	if run.out.String() != page+"\n" || WshExitCode != 0 {
		t.Fatalf("the page is printed as the tool returned it: %q (exit %d)", run.out.String(), WshExitCode)
	}
	run.out.Reset()
	run.run("read", "3", "--json")
	var parsed map[string]any
	if err := json.Unmarshal(run.out.Bytes(), &parsed); err != nil || parsed["tabId"] != float64(3) || parsed["text"] != page || parsed["source"] != "main" {
		t.Fatalf("--json carries the tool's fields and the wrapped text: %s %v", run.out.String(), err)
	}
}

func TestBrowserReadAndShowTakeTheLatestTabWhenNoneIsNamed(t *testing.T) {
	run := startBrowserRun(t, func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error) {
		if req.Tool == mcpbrowser.ToolTabsContext {
			result := mcpbrowser.TextResult("{}")
			result.Data = json.RawMessage(`{"tabs":[{"tabId":2,"owner":"you","state":"active"},{"tabId":5,"owner":"you","state":"active"},{"tabId":7,"owner":"you","state":"takenover"}]}`)
			return result, nil
		}
		return mcpbrowser.TextResult(`{"tabId":5,"shown":true}` + "\nTab 5 is in front of the user."), nil
	})
	run.run("show")
	if got := strings.Join(run.tools(), "|"); got != `tabs_context {}|tabs_show {"tabId":5}` {
		t.Fatalf("the latest tab the agent can still use: %s", got)
	}
	if !strings.Contains(run.out.String(), "Tab 5 is in front of the user.") {
		t.Fatalf("out: %q", run.out.String())
	}
}

func TestBrowserReadWithNoTabSaysHowToOpenOne(t *testing.T) {
	run := startBrowserRun(t, func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error) {
		result := mcpbrowser.TextResult("{}")
		result.Data = json.RawMessage(`{"tabs":[]}`)
		return result, nil
	})
	cmd := moltenCommandByWords("browser read")
	if err := moltenBrowserRun(mustBinding(t, "browser read"), cmd, nil); err == nil || err.Error() != mcpbrowser.ErrNoTab {
		t.Fatalf("no tab: %v", err)
	}
	if len(run.requests) != 1 {
		t.Fatalf("nothing is read when there is no tab: %v", run.tools())
	}
}

func mustBinding(t *testing.T, command string) mcpbrowser.CliBinding {
	t.Helper()
	b, ok := mcpbrowser.CliBindingFor(command)
	if !ok {
		t.Fatalf("no binding for %s", command)
	}
	return b
}

func TestBrowserOpenSendsTheAddressAndTheFlagsOfTheTool(t *testing.T) {
	run := startBrowserRun(t, func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error) {
		return mcpbrowser.TextResult(`{"tabId":4,"result":"opened tab 4","reused":false}` + "\nOpened tab 4 in the browser panel next to the terminal."), nil
	})
	run.run("open", "docs.example/guide")
	run.run("open", "--new-tab", "--reload", "https://docs.example/a")
	want := []string{`tabs_create {"url":"https://docs.example/guide"}`, `tabs_create {"newTab":true,"reload":true,"url":"https://docs.example/a"}`}
	if got := run.tools(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("requests: %v, want %v", got, want)
	}
	if strings.Count(run.out.String(), "Opened tab 4 in the browser panel next to the terminal.") != 2 {
		t.Fatalf("out: %q", run.out.String())
	}
}

func TestBrowserOpenRefusesWhatNoToolOpensBeforeAskingWavesrv(t *testing.T) {
	run := startBrowserRun(t, func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error) {
		return mcpbrowser.TextResult("{}"), nil
	})
	for _, target := range []string{"ftp://example.com", "data:text/html,<p>", "javascript:alert(1)", "/no/such/file.html", ""} {
		err := moltenBrowserOpen(mustBinding(t, "browser open"), target, nil)
		if err == nil {
			t.Errorf("%q must be refused", target)
		}
	}
	if len(run.requests) != 0 {
		t.Fatalf("a refused target never reaches wavesrv: %v", run.tools())
	}
}

func TestBrowserListPrintsTheListingAndItsJson(t *testing.T) {
	run := startBrowserRun(t, func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error) {
		result := mcpbrowser.TextResult("{}")
		result.Data = json.RawMessage(`{"tabs":[{"tabId":3,"owner":"you","state":"active","site":"docs.example","title":"Guide","url":"https://docs.example/guide"}],` +
			`"otherPages":[{"page":1,"owner":"user","state":"open","panel":"panel 1 of this tab","url":"https://app.example"}]}`)
		return result, nil
	})
	run.run("list")
	for _, want := range []string{"tab 3 (yours, active)", `"Guide" https://docs.example/guide`, "page 1 (the developer's, open, panel 1 of this tab)", mcpbrowser.CliUntrustedNotice} {
		if !strings.Contains(run.out.String(), want) {
			t.Errorf("the listing misses %q:\n%s", want, run.out.String())
		}
	}
	run.out.Reset()
	run.run("list", "--json")
	var parsed struct {
		Tabs       []mcpbrowser.ContextTab  `json:"tabs"`
		OtherPages []mcpbrowser.ContextPage `json:"otherPages"`
		Notice     string                   `json:"notice"`
	}
	if err := json.Unmarshal(run.out.Bytes(), &parsed); err != nil || len(parsed.Tabs) != 1 || parsed.Tabs[0].TabId != 3 || len(parsed.OtherPages) != 1 ||
		parsed.Notice != mcpbrowser.CliUntrustedNotice {
		t.Fatalf("list --json: %s %v", run.out.String(), err)
	}
}

func TestBrowserFailuresExitOneWithTheToolsOwnSentence(t *testing.T) {
	for _, sentence := range []string{mcpbrowser.ErrNotYourTab, mcpbrowser.ErrTakenOver, mcpbrowser.ErrSiteBlocked, mcpbrowser.ErrNotInMoltenTerm} {
		run := startBrowserRun(t, func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error) {
			return mcpbrowser.ErrorResult(sentence), nil
		})
		cmd := moltenCommandByWords("browser show")
		cmd.Flags().VisitAll(func(f *pflag.Flag) { f.Value.Set(f.DefValue); f.Changed = false })
		if err := cmd.RunE(cmd, []string{"9"}); err != nil {
			t.Fatalf("a failure is reported, not returned: %v", err)
		}
		if run.errOut.String() != "molten: "+sentence+"\n" || WshExitCode != 1 || run.out.Len() != 0 {
			t.Errorf("%q: stderr %q exit %d stdout %q", sentence, run.errOut.String(), WshExitCode, run.out.String())
		}
	}
	run := startBrowserRun(t, func(req mcpbrowser.CliRequest) (mcpbrowser.CallResult, error) {
		return mcpbrowser.CallResult{}, errors.New("MoltenTerm's browser can be driven from local terminals only")
	})
	moltenJson = true
	cmd := moltenCommandByWords("browser close")
	if err := cmd.RunE(cmd, []string{"3"}); err != nil {
		t.Fatal(err)
	}
	var parsed map[string]string
	if err := json.Unmarshal(run.errOut.Bytes(), &parsed); err != nil || parsed["error"] != "MoltenTerm's browser can be driven from local terminals only" || WshExitCode != 1 {
		t.Fatalf("with --json the error is JSON on stderr: %q %v (exit %d)", run.errOut.String(), err, WshExitCode)
	}
}

func TestBrowserCommandsOutsideMoltenTermAnswerAsTheToolsDo(t *testing.T) {
	t.Setenv(wshutil.WaveJwtTokenVarName, "")
	for _, command := range []string{"browser list", "browser open", "browser read", "browser show", "browser close"} {
		cmd := moltenCommandByWords(command)
		if err := cmd.PreRunE(cmd, nil); err == nil || err.Error() != mcpbrowser.ErrNotInMoltenTerm {
			t.Errorf("%s outside MoltenTerm: %v", command, err)
		}
	}
}
