// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package uimsg_test

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The guard of #656 (AC2): a result field wavesrv fills with English for a window carries its code beside it, and
// every code has its sentence in the shipped locales.

const moltenDir = ".."

var localesDir = filepath.Join("..", "..", "..", "frontend", "moltenterm-shell", "i18n", "locales")

// The json names of the fields that hold a sentence.
var textFieldNames = map[string]bool{
	"message": true, "error": true, "detail": true, "reason": true, "warning": true, "warnings": true,
	"note": true, "msg": true, "err": true, "why": true, "errors": true,
}

// Text fields that need no code, by "package.Struct.Field", with why. Agent-facing text, `molten` output and logs stay
// English; a field that already holds a code is a code, not a sentence.
var englishFields = map[string]string{
	"review.MergePlan.Warnings":            "check ids (MergeCheck codes), worded by the Validate sheet",
	"review.MergeRecord.Error":             "gh's raw error (tokens masked), the detail under Code, which the sheet words",
	"review.MarkReadyResult.Reason":        "a code (MarkReadyReason…) the Reviews list words",
	"review.MarkReadyResult.Message":       "gh's raw error, the detail of the reason error",
	"review.RestartResult.Reason":          "a code (RestartReason…) the Review tab words",
	"review.DiscussRequest.Message":        "the developer's own message, typed for the agent",
	"review.PublishNote.Note":              "a code (Note…) the Publish sheet words",
	"reviewsession.sourceInfo.Why":         "review_context output, agent-facing",
	"reviewsession.ciInfo.Why":             "review_context output, agent-facing",
	"reviewsession.untrustedText.Note":     "MCP tool output, agent-facing",
	"reviewsession.reviewContext.Note":     "review_context output, agent-facing",
	"reviewsession.translateInfo.Note":     "MCP tool output, agent-facing",
	"mcpreview.BriefResult.Reason":         "a code (#652) the Review tab words (review-session-text.ts)",
	"mcpreview.BriefResult.Message":        "the English detail of Reason's code (#652)",
	"mcpreview.SessionInfo.Reason":         "a code (#652) the Review tab words (review-session-text.ts)",
	"mcpreview.SessionInfo.Message":        "the English detail of Reason's code (#652)",
	"mcpreview.StartResult.Reason":         "a code (#652) the Review tab words (review-session-text.ts)",
	"mcpreview.StartResult.Message":        "the English detail of Reason's code (#652)",
	"mcpreview.AskResult.Reason":           "a code (#652) the Review tab words (review-session-text.ts)",
	"mcpreview.AskResult.Message":          "the English detail of Reason's code (#652)",
	"mcpreview.DiscussRequest.Message":     "the developer's own message, typed for the agent",
	"termupdate.AgentInputResult.Reason":   "a code (InputReason...), not a sentence",
	"termupdate.OutdatedTerminal.Reason":   "a code (Reason...), the header words it under termupdate.*",
	"molten.DurableSession.Reason":         "a code (SessionReason...), the Sessions view words it under sessions.reason.*",
	"handoffwire.SendResult.Message":       "agent-facing: the sending agent reads it (MCP send_to_agent)",
	"handoffwire.FileRef.Note":             "agent-written brief content, typed for the receiving agent",
	"handoffwire.LinkRef.Note":             "agent-written brief content, typed for the receiving agent",
	"mission.BranchPlan.Reason":            "a code (merged-pr, open-pr...) the window words under mc.branches.reason/keep",
	"mission.GithubSnapshot.Message":       "gh's own error output, shown inside mc.github.state.error",
	"mission.ReviewsAnswer.Message":        "gh's own error output (the collector's GithubSnapshot.Message)",
	"molten.PipelineReport.Errors":         "the project file validator's diagnostics, shared with `molten project validate` and the agents that fix the file",
	"molten.PipelineReport.Warnings":       "the project file validator's diagnostics, shared with `molten project validate`",
	"versions.BumpDecision.Reason":         "`molten release plan` output; the window computes its own plan (releases/versions.ts)",
	"versions.PlanResult.Reason":           "`molten release plan` output; the window computes its own plan (releases/versions.ts)",
	"agentcontinuity.Capability.Note":      "agent capability table read by `molten` and agents, not shown in a window",
	"agentcontinuity.BriefingChannel.Note": "agent capability table read by `molten` and agents, not shown in a window",
	"agentcontinuity.Detection.Reason":     "install detection read by `molten` and logs, not shown in a window",
	"agenthook.AgentStateRequest.Message":  "the agent's own words, sent by `molten agent state`: data, not a sentence of ours",
	"agenthook.rpcMessage.Error":           "the RPC wire's error string, read by `molten`, never shown in a window",
	"molten.AgentHookOffer.Reason":         "already a code (HookOffer…), worded by the window",
	"molten.AgentStateRequest.Message":     "the agent's own words, sent by `molten agent state`: data, not a sentence of ours",
	"molten.AgentStateInfo.Message":        "the agent's own words, relayed as they are: data, not a sentence of ours",
	"browseragent.setFieldResult.Error":    "page script result read by the browser tools, the agent sees it",
	"browseragent.navigateResult.Error":    "navigation result read by the browser tools, the agent sees it",
	"companion.ExperimentalInfo.Reason":    "already a code (UsageReason), worded by companion-gauges-model.ts",
	"companion.UsageInfo.Reason":           "already a code (UsageReason), worded by companion-gauges-model.ts",
	"keepawake.PermissionAnswer.Reason":    "the answer the agent's PermissionRequest hook reads (agent-facing); the window shows Approval.ReasonText",
	"keepawake.Approval.Detail":            "the request's command or path (data, not a sentence)",
	"mcpbrowser.rpcError.Message":          "MCP error the agent reads (agent-facing)",
	"agentparts.PartState.Reason":          "read only by `molten mod` output (cmd/wsh), which stays English",
}

type textField struct {
	key      string
	pos      string
	hasCoded bool
}

func jsonName(tag *ast.BasicLit) string {
	if tag == nil {
		return ""
	}
	raw, err := strconv.Unquote(tag.Value)
	if err != nil {
		return ""
	}
	name, _, _ := strings.Cut(reflect.StructTag(raw).Get("json"), ",")
	return name
}

func isTextType(expr ast.Expr) bool {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name == "string"
	case *ast.ArrayType:
		id, ok := e.Elt.(*ast.Ident)
		return ok && id.Name == "string"
	}
	return false
}

func isCodedType(expr ast.Expr) bool {
	switch e := expr.(type) {
	case *ast.StarExpr:
		return isCodedType(e.X)
	case *ast.ArrayType:
		return isCodedType(e.Elt)
	case *ast.SelectorExpr:
		pkg, ok := e.X.(*ast.Ident)
		return ok && pkg.Name == "uimsg" && e.Sel.Name == "Text"
	case *ast.Ident:
		return e.Name == "Text"
	}
	return false
}

func goSources(t *testing.T) []string {
	t.Helper()
	var files []string
	err := filepath.WalkDir(moltenDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func textFields(t *testing.T) []textField {
	t.Helper()
	var out []textField
	fset := token.NewFileSet()
	for _, path := range goSources(t) {
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			spec, ok := n.(*ast.TypeSpec)
			if !ok {
				return true
			}
			st, ok := spec.Type.(*ast.StructType)
			if !ok {
				return true
			}
			coded := map[string]bool{}
			for _, f := range st.Fields.List {
				if isCodedType(f.Type) {
					for _, name := range f.Names {
						coded[name.Name] = true
					}
				}
			}
			for _, f := range st.Fields.List {
				if !isTextType(f.Type) || !textFieldNames[jsonName(f.Tag)] {
					continue
				}
				for _, name := range f.Names {
					out = append(out, textField{
						key:      file.Name.Name + "." + spec.Name.Name + "." + name.Name,
						pos:      fset.Position(f.Pos()).String(),
						hasCoded: coded[name.Name+"Text"],
					})
				}
			}
			return true
		})
	}
	return out
}

func TestTextFieldsCarryACode(t *testing.T) {
	fields := textFields(t)
	if len(fields) < 20 {
		t.Fatalf("found only %d text fields: the scan is broken", len(fields))
	}
	seen := map[string]bool{}
	var missing []string
	for _, f := range fields {
		seen[f.key] = true
		if f.hasCoded {
			continue
		}
		if _, ok := englishFields[f.key]; ok {
			continue
		}
		missing = append(missing, f.pos+": "+f.key)
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("text fields without a sibling <Field>Text *uimsg.Text (add one and fill it, or list the field in englishFields with why):\n%s", strings.Join(missing, "\n"))
	}
	var stale []string
	for key := range englishFields {
		if !seen[key] {
			stale = append(stale, key)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("englishFields entries that match no text field: %v", stale)
	}
}

var makeCall = regexp.MustCompile(`uimsg\.Make\(\s*([^,)]*)`)

func loadLocale(t *testing.T, code string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(localesDir, code+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var dict map[string]any
	if err := json.Unmarshal(raw, &dict); err != nil {
		t.Fatal(err)
	}
	return dict
}

func lookup(dict map[string]any, key string) (string, bool) {
	var cur any = dict
	for _, part := range strings.Split(key, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return "", false
		}
		cur, ok = m[part]
		if !ok {
			return "", false
		}
	}
	s, ok := cur.(string)
	return s, ok
}

func TestCodesHaveTheirSentences(t *testing.T) {
	locales := map[string]map[string]any{"en": loadLocale(t, "en"), "fr": loadLocale(t, "fr")}
	codes := 0
	var problems []string
	for _, path := range goSources(t) {
		if filepath.Base(filepath.Dir(path)) == "uimsg" {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range makeCall.FindAllStringSubmatch(string(raw), -1) {
			code, err := strconv.Unquote(strings.TrimSpace(m[1]))
			if err != nil {
				problems = append(problems, path+": uimsg.Make's code must be a string literal, got "+m[1])
				continue
			}
			codes++
			for lang, dict := range locales {
				if _, ok := lookup(dict, "server."+code); !ok {
					problems = append(problems, path+": "+lang+".json has no key server."+code)
				}
			}
		}
	}
	sort.Strings(problems)
	if len(problems) > 0 {
		t.Errorf("%s", strings.Join(problems, "\n"))
	}
	t.Logf("%d coded sentences", codes)
}
