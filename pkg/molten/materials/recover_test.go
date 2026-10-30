// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// pastRoots are the agents' session folders of a harness, as a past-session search reads them.
type pastRoots struct {
	claude string
	codex  string
}

func (h *harness) pastRoots() pastRoots {
	base := filepath.Dir(h.root)
	return pastRoots{claude: filepath.Join(base, "claude", "projects"), codex: filepath.Join(base, "codex", "sessions")}
}

func (h *harness) adapters() []companion.Adapter {
	roots := h.pastRoots()
	return []companion.Adapter{companion.MakeClaudeAdapter([]string{roots.claude}), companion.MakeCodexAdapter([]string{roots.codex})}
}

// writePast writes a transcript from fixtures, with {{CWD}} the session's folder.
func (h *harness) writePast(path string, cwd string, fixtures ...string) {
	h.t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	for _, fixture := range fixtures {
		data, err := os.ReadFile(filepath.Join("testdata", fixture))
		if err != nil {
			h.t.Fatal(err)
		}
		text := strings.ReplaceAll(strings.ReplaceAll(string(data), "{{DIR}}", h.dir), "{{CWD}}", cwd)
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			h.t.Fatal(err)
		}
		f.WriteString(text)
		f.Close()
	}
}

func (h *harness) writePastLines(path string, lines ...string) {
	h.t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	text := strings.ReplaceAll(strings.Join(lines, "\n")+"\n", "{{DIR}}", h.dir)
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) recoverNow() molten.MaterialsRecovered {
	h.t.Helper()
	key, folder := ProjectKey(h.project)
	return h.r.recover(key, folder, h.adapters())
}

const pastSession = "5e55e55e-0000-4000-8000-0000000014aa"

func pastPublishLines(cwd string, url string, path string, title string, seq int) []string {
	return []string{
		`{"type":"user","sessionId":"` + pastSession + `","cwd":"` + cwd + `","gitBranch":"feature/1432-x","timestamp":"2026-10-30T10:00:00.000Z","message":{"role":"user","content":"Publish the proposal"}}`,
		`{"type":"user","sessionId":"` + pastSession + `","cwd":"` + cwd + `","timestamp":"2026-10-30T10:01:00.000Z","message":{"role":"user","content":[{"tool_use_id":"toolu_P","type":"tool_result","content":"Published"}]},"toolUseResult":{"url":"` + url + `","path":"` + path + `","artifact_id":"aa-` + title + `","title":"` + title + `","updated":false,"seq":` + string(rune('0'+seq)) + `}}`,
		`{"type":"frame-link","sessionId":"` + pastSession + `","path":"` + path + `","frameUrl":"` + url + `","title":"` + title + `","artifactCount":1,"timestamp":"2026-10-30T10:01:00.100Z"}`,
	}
}

// TC-MAT-018: the past sessions of the project, its worktrees' (Claude Code's other folder) and its sub-agents', for
// Claude Code and Codex, give their published pages and addresses; republications at one address are one material;
// an erased source stays a link; another project's folder that shares the name's start is not read; a second search
// duplicates nothing.
func TestRecoverPastSessions(t *testing.T) {
	h := makeHarness(t)
	h.writeProposal()
	roots := h.pastRoots()
	slug := companion.ClaudeSlug(h.project)

	main := filepath.Join(roots.claude, slug, "5e55e55e-0000-4000-8000-000000001395.jsonl")
	h.writePast(main, h.project, "claude-publish.jsonl", "claude-republish.jsonl")

	removed := filepath.Join(h.project, ".claude", "worktrees", "agent-a1")
	h.writePastLines(filepath.Join(roots.claude, slug+"--claude-worktrees-agent-a1", pastSession+".jsonl"),
		pastPublishLines(removed, "https://claude.ai/artifact/GoneSource01", "{{DIR}}/erased/report.html", "Erased report", 1)...)

	h.write("sub/notes.html", "<html>sub-agent page</html>")
	h.writePastLines(filepath.Join(roots.claude, slug, "5e55e55e-0000-4000-8000-000000001395", "subagents", "agent-b2.jsonl"),
		pastPublishLines(h.project, "https://claude.ai/artifact/SubAgentPage1", "{{DIR}}/sub/notes.html", "Sub-agent notes", 1)...)

	h.write("other/page.html", "<html>another project</html>")
	h.writePastLines(filepath.Join(roots.claude, slug+"-old", pastSession+".jsonl"),
		pastPublishLines(h.project+"-old", "https://claude.ai/artifact/OtherProject1", "{{DIR}}/other/page.html", "Other", 1)...)

	h.writePast(filepath.Join(roots.codex, "2026", "10", "30", "rollout-2026-10-30T09-00-00-0199aaaa-1301-7ccc-8ddd-eeeeffff1301.jsonl"), h.project, "codex-patch.jsonl")

	out := h.recoverNow()
	if out.Sessions != 4 || out.Found != 4 || out.New != 4 || out.Kept != 2 || out.Gone != 1 {
		t.Fatalf("report: %+v", out)
	}
	list := h.list()
	page := byLink(list, "https://claude.ai/artifact/Nsoo26TestPage")
	if page == nil || page.Title != "Le 360 en onglets v2" || page.Copy != molten.MaterialCopyKept || page.Ticket != 1395 || page.Tool != molten.AgentIdClaude {
		t.Fatalf("republished page: %+v", page)
	}
	if len(page.Versions) != 1 || page.Versions[0].N != 2 || page.Files != 4 {
		t.Errorf("one source left, numbered after its latest publication: %+v", page.Versions)
	}
	if published := time.Date(2026, 10, 30, 11, 3, 5, 0, time.UTC).UnixMilli(); page.Versions[0].At != published || page.Created > published {
		t.Errorf("a recovered material is dated by its publication: %+v", page)
	}
	gone := byLink(list, "https://claude.ai/artifact/GoneSource01")
	if gone == nil || gone.Copy != molten.MaterialCopyMissing || len(gone.Versions) != 0 || gone.Title != "Erased report" {
		t.Errorf("erased source: %+v", gone)
	}
	if sub := byLink(list, "https://claude.ai/artifact/SubAgentPage1"); sub == nil || sub.Copy != molten.MaterialCopyKept {
		t.Errorf("sub-agent's page: %+v", sub)
	}
	if byLink(list, "https://claude.ai/artifact/OtherProject1") != nil {
		t.Errorf("another project's session was read")
	}
	codex := byLink(list, "https://claude.ai/code/artifact/CodexDemo42")
	if codex == nil || codex.Source != molten.MaterialSourceNamed || codex.Tool != molten.AgentIdCodex {
		t.Errorf("Codex's named address: %+v", codex)
	}
	if work, _ := h.r.store.WorkFiles(h.key()); len(work) != 0 {
		t.Errorf("a search keeps no work files: %+v", work)
	}

	again := h.recoverNow()
	if again.Found != 4 || again.New != 0 || len(h.list()) != len(list) {
		t.Fatalf("a second search duplicated: %+v, %d materials", again, len(h.list()))
	}
}

// Two sources at one address are two versions, in the order they were published (Audit v1, then v2 from another file).
func TestRecoverTwoSources(t *testing.T) {
	h := makeHarness(t)
	h.write("audit/report.html", "<html>v1</html>")
	h.write("audit/report-v2.html", "<html>v2</html>")
	url := "https://claude.ai/artifact/AuditTwoFiles"
	lines := pastPublishLines(h.project, url, "{{DIR}}/audit/report.html", "Audit Spaces", 1)
	lines = append(lines, pastPublishLines(h.project, url, "{{DIR}}/audit/report-v2.html", "Audit v2", 2)[1:]...)
	h.writePastLines(filepath.Join(h.pastRoots().claude, companion.ClaudeSlug(h.project), pastSession+".jsonl"), lines...)
	out := h.recoverNow()
	m := byLink(h.list(), url)
	if out.Found != 1 || m == nil || len(m.Versions) != 2 || m.Versions[0].N != 1 || m.Versions[1].N != 2 || m.Title != "Audit v2" {
		t.Fatalf("report %+v, material %+v", out, m)
	}
	if !strings.HasSuffix(m.CopyPath, "report-v2.html") {
		t.Errorf("the current copy is the latest source: %s", m.CopyPath)
	}
	if m.Ticket != 1432 {
		t.Errorf("a session on one branch gives its ticket: %d", m.Ticket)
	}
}

// A main checkout's session records the branches of its agents' worktrees: it gives no ticket by branch.
func TestRecoverSessionOfSeveralBranches(t *testing.T) {
	h := makeHarness(t)
	h.write("p/page.html", "<html>p</html>")
	url := "https://claude.ai/artifact/SeveralBranches"
	lines := pastPublishLines(h.project, url, "{{DIR}}/p/page.html", "Page", 1)
	lines = append(lines, `{"type":"user","sessionId":"`+pastSession+`","cwd":"`+h.project+`","gitBranch":"feature/1461-any-agent","timestamp":"2026-10-30T12:00:00.000Z","message":{"role":"user","content":"next"}}`)
	h.writePastLines(filepath.Join(h.pastRoots().claude, companion.ClaudeSlug(h.project), pastSession+".jsonl"), lines...)
	h.recoverNow()
	if m := byLink(h.list(), url); m == nil || m.Ticket != 0 {
		t.Fatalf("ticket taken from a shared branch: %+v", m)
	}
}

// A material the registry already holds is found, not duplicated, and keeps its copy.
func TestRecoverKnownMaterial(t *testing.T) {
	h := makeHarness(t)
	h.writeProposal()
	tr := h.claudeTranscript("claude-publish.jsonl")
	h.poll(tr, molten.AgentIdClaude)
	before := byLink(h.list(), "https://claude.ai/artifact/Nsoo26TestPage")
	out := h.recoverNow()
	after := byLink(h.list(), "https://claude.ai/artifact/Nsoo26TestPage")
	if out.Found < 1 || out.New != 0 || after == nil || after.Id != before.Id || len(after.Versions) != 1 {
		t.Fatalf("report %+v, before %+v, after %+v", out, before, after)
	}
}

// The live list of signals keeps the publications when a long read fills it with answers.
func TestLiveSignalsKeepPublications(t *testing.T) {
	h := makeHarness(t)
	h.writeProposal()
	tr := h.claudeTranscript("claude-publish.jsonl")
	var answers []string
	for i := 0; i < companion.MaxMaterialSignals+50; i++ {
		answers = append(answers, `{"type":"assistant","sessionId":"5e55e55e-0000-4000-8000-000000001395","timestamp":"2026-10-30T10:05:00.000Z","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"See https://example.com/a"}]}}`)
	}
	f, _ := os.OpenFile(tr.path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(strings.Join(answers, "\n") + "\n")
	f.Close()
	h.poll(tr, molten.AgentIdClaude)
	if page := byLink(h.list(), "https://claude.ai/artifact/Nsoo26TestPage"); page == nil {
		t.Fatalf("the publication was dropped from a full list")
	}
}

// A design page's CSS (li.key::before) and French prose ("secret : des") are not secrets: the page is copied.
func TestDesignPageIsNotASecret(t *testing.T) {
	h := makeHarness(t)
	h.write("360/proposal.html", `<style>.life li.key::before { border-color: red; }</style><p>Le secret : des copies.</p>`)
	tr := h.claudeTranscript("claude-publish.jsonl")
	h.poll(tr, molten.AgentIdClaude)
	page := byLink(h.list(), "https://claude.ai/artifact/Nsoo26TestPage")
	if page == nil || page.Copy != molten.MaterialCopyKept {
		t.Fatalf("design page held back: %+v", page)
	}
}
