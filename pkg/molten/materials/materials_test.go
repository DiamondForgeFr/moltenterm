// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity/checkpoint"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

type harness struct {
	t       *testing.T
	r       *Registry
	root    string
	home    string
	dir     string
	project string
	remote  bool
	term    string
}

func makeHarness(t *testing.T) *harness {
	t.Helper()
	base := t.TempDir()
	h := &harness{t: t, root: filepath.Join(base, "data", "molten", "materials"), home: filepath.Join(base, "home"), dir: filepath.Join(base, "scratch"), project: filepath.Join(base, "project")}
	for _, d := range []string{h.home, h.dir, h.project} {
		os.MkdirAll(d, 0o755)
	}
	store := MakeStore(h.root)
	h.r = MakeRegistry(store, h.home, []string{filepath.Join(base, "data")})
	h.r.blockInfo = func(blockId string) (BlockInfo, error) {
		return BlockInfo{WorkspaceId: "ws-1", Project: h.project, Remote: h.remote}, nil
	}
	h.r.workspaceOf = func(wsId string) (BlockInfo, error) {
		return BlockInfo{WorkspaceId: wsId, Project: h.project}, nil
	}
	h.r.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		return molten.AgentRunInfo{BlockId: blockId, Agent: molten.AgentIdClaude, FirstName: "Adrien", Running: true}, true
	}
	return h
}

func (h *harness) key() string {
	key, _ := ProjectKey(h.project)
	return key
}

func (h *harness) write(rel string, content string) string {
	h.t.Helper()
	path := filepath.Join(h.dir, rel)
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		h.t.Fatal(err)
	}
	return path
}

func (h *harness) writePng(rel string, w int, hgt int) string {
	h.t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, hgt))
	for x := 0; x < w; x++ {
		img.Set(x, x%hgt, color.NRGBA{R: 200, G: 80, B: 20, A: 255})
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	return h.write(rel, buf.String())
}

func (h *harness) list() []molten.Material {
	h.t.Helper()
	list, err := h.r.store.List(h.key())
	if err != nil {
		h.t.Fatal(err)
	}
	return list
}

func (h *harness) feed(feed checkpoint.MaterialFeed) {
	if feed.BlockId == "" {
		feed.BlockId = "block-1"
	}
	if feed.Agent == "" {
		feed.Agent = molten.AgentIdClaude
	}
	h.r.process(feed)
}

func (h *harness) feedSession(s *companion.Session) {
	h.feed(checkpoint.MaterialFeed{Batch: s.MaterialSignals(0)})
}

func byLink(list []molten.Material, link string) *molten.Material {
	for i := range list {
		if list[i].Link == link {
			return &list[i]
		}
	}
	return nil
}

func byOriginalName(list []molten.Material, name string) *molten.Material {
	for i := range list {
		if list[i].OriginalName == name {
			return &list[i]
		}
	}
	return nil
}

// transcript writes a fixture under an adapter's session root and returns a reader on it.
type transcript struct {
	path   string
	reader *companion.SessionReader
	seq    int64
}

func (h *harness) claudeTranscript(fixture string) *transcript {
	h.t.Helper()
	root := filepath.Join(filepath.Dir(h.root), "claude", "projects")
	path := filepath.Join(root, companion.ClaudeSlug(h.project), "5e55e55e-0000-4000-8000-000000001395.jsonl")
	h.appendFixture(path, fixture)
	reader, err := companion.OpenAdapterSessionReader(companion.MakeClaudeAdapter([]string{root}), path)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(reader.Close)
	return &transcript{path: path, reader: reader}
}

func (h *harness) codexTranscript(fixture string) *transcript {
	h.t.Helper()
	root := filepath.Join(filepath.Dir(h.root), "codex", "sessions")
	path := filepath.Join(root, "2026", "10", "30", "rollout-2026-10-30T09-00-00-0199aaaa-1301-7ccc-8ddd-eeeeffff1301.jsonl")
	h.appendFixture(path, fixture)
	reader, err := companion.OpenAdapterSessionReader(companion.MakeCodexAdapter([]string{root}), path)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(reader.Close)
	return &transcript{path: path, reader: reader}
}

func (h *harness) appendFixture(path string, fixture string) {
	h.t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", fixture))
	if err != nil {
		h.t.Fatal(err)
	}
	text := strings.ReplaceAll(strings.ReplaceAll(string(data), "{{DIR}}", h.dir), "{{CWD}}", h.project)
	os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		h.t.Fatal(err)
	}
	defer f.Close()
	f.WriteString(text)
}

// poll reads what the transcript gained and hands its signals to the registry, as the checkpoint's updater does.
func (h *harness) poll(tr *transcript, agent string) {
	h.t.Helper()
	if _, err := tr.reader.Poll(); err != nil {
		h.t.Fatal(err)
	}
	batch := tr.reader.MaterialSignals(tr.seq)
	tr.seq = batch.Seq
	h.feed(checkpoint.MaterialFeed{Agent: agent, SessionPath: tr.path, Batch: batch})
}

const proposalHtml = `<!doctype html><html><head><title>Ignored: the tool's title wins</title>
<link rel="stylesheet" href="style.css"></head><body>
<img src="shots/cut-01.png"><img src="shots/cut-02.png?v=2"><img src="https://cdn.example.com/x.png">
<a href="#top">top</a><img src="../outside.png"><img src="/abs/root.png"></body></html>`

func (h *harness) writeProposal() {
	h.write("360/proposal.html", proposalHtml)
	h.writePng("360/shots/cut-01.png", 20, 10)
	h.writePng("360/shots/cut-02.png", 20, 10)
	h.write("360/style.css", "body{font-family:x} @font-face{src:url('fonts/a.woff2')}")
	h.write("360/fonts/a.woff2", "font")
	h.write("outside.png", "png")
	h.writePng("360/four-states.png", 1600, 900)
	h.writePng("360/probe8.png", 4, 4)
}

// TC-MAT-001: a published page is kept with its link and linked files; the file named in the answer is kept; a
// GitHub issue is not; the trial image the agent wrote is a work file. A republication is a second version.
func TestClaudePublicationFixture(t *testing.T) {
	h := makeHarness(t)
	h.writeProposal()
	tr := h.claudeTranscript("claude-publish.jsonl")
	h.poll(tr, molten.AgentIdClaude)

	list := h.list()
	if len(list) != 2 {
		t.Fatalf("want the page and the named capture, got %d: %+v", len(list), list)
	}
	page := byLink(list, "https://claude.ai/artifact/Nsoo26TestPage")
	if page == nil {
		t.Fatalf("no page material: %+v", list)
	}
	if page.Title != "Le 360 en onglets" || page.Kind != molten.MaterialKindPage || page.Source != molten.MaterialSourcePublished {
		t.Errorf("page: %+v", page)
	}
	if page.ArtifactId != "0f3c2b1a-1395-4000-8000-000000000001" || page.Ticket != 1395 || page.Agent != "Adrien" || page.Tool != molten.AgentIdClaude {
		t.Errorf("page record: %+v", page)
	}
	if page.Copy != molten.MaterialCopyKept || len(page.Versions) != 1 || !page.MayBeLost {
		t.Fatalf("page copy: %+v", page)
	}
	if page.Files != 4 {
		t.Errorf("want 4 linked files (2 captures, the style and its font), got %d", page.Files)
	}
	copyDir := filepath.Dir(page.CopyPath)
	for _, rel := range []string{"proposal.html", "shots/cut-01.png", "shots/cut-02.png", "style.css", "fonts/a.woff2"} {
		if _, err := os.Stat(filepath.Join(copyDir, rel)); err != nil {
			t.Errorf("copy lacks %s", rel)
		}
	}
	if _, err := os.Stat(filepath.Join(copyDir, "outside.png")); err == nil {
		t.Errorf("a file outside the page's folder was copied")
	}
	capture := byOriginalName(list, "four-states.png")
	if capture == nil || capture.Source != molten.MaterialSourceNamed || capture.Copy != molten.MaterialCopyKept {
		t.Fatalf("named capture: %+v", capture)
	}
	if capture.Title != "Four states · Write the 360 proposal and publish it" {
		t.Errorf("capture title %q subject %q: %+v", capture.Title, capture.Subject, capture)
	}
	if !capture.Thumb {
		t.Errorf("an image gets a preview")
	} else {
		thumb := filepath.Join(h.root, h.key(), itemsDir, capture.Id, thumbFile)
		info, err := os.Stat(thumb)
		if err != nil || info.Size() > int64(DefaultLimits().ThumbBytes) {
			t.Errorf("thumb: %v %v", info, err)
		}
		f, _ := os.Open(thumb)
		cfg, _, err := image.DecodeConfig(f)
		f.Close()
		if err != nil || cfg.Width > 640 || cfg.Height > 640 {
			t.Errorf("thumb size %+v %v", cfg, err)
		}
	}
	work, _ := h.r.store.WorkFiles(h.key())
	if len(work) != 1 || filepath.Base(work[0].Path) != "probe8.png" {
		t.Errorf("work files: %+v", work)
	}

	// The agent republishes at the same link, with a changed page.
	h.write("360/proposal.html", proposalHtml+"<p>v2</p>")
	h.appendFixture(tr.path, "claude-republish.jsonl")
	h.poll(tr, molten.AgentIdClaude)
	list = h.list()
	if len(list) != 2 {
		t.Fatalf("a republication is not a new material: %+v", list)
	}
	page = byLink(list, "https://claude.ai/artifact/Nsoo26TestPage")
	if len(page.Versions) != 2 || page.Title != "Le 360 en onglets v2" {
		t.Fatalf("republication: %d versions, title %q", len(page.Versions), page.Title)
	}
	if page.Versions[1].Files != 4 {
		t.Errorf("the second version keeps the linked files the page names: %d", page.Versions[1].Files)
	}
}

// A renamed material keeps its name through a republication; its automatic title still follows.
func TestRenameSurvivesRepublication(t *testing.T) {
	h := makeHarness(t)
	h.writeProposal()
	tr := h.claudeTranscript("claude-publish.jsonl")
	h.poll(tr, molten.AgentIdClaude)
	page := byLink(h.list(), "https://claude.ai/artifact/Nsoo26TestPage")
	if _, err := h.r.store.Rename(h.key(), page.Id, "Proposition 360"); err != nil {
		t.Fatal(err)
	}
	h.write("360/proposal.html", proposalHtml+"<p>v2</p>")
	h.appendFixture(tr.path, "claude-republish.jsonl")
	h.poll(tr, molten.AgentIdClaude)
	got, _ := h.r.store.Get("", page.Id)
	if got.Title != "Proposition 360" || !got.Renamed || got.AutoTitle != "Le 360 en onglets v2" {
		t.Errorf("rename lost: %+v", got)
	}
	got, _ = h.r.store.Rename(h.key(), page.Id, "")
	if got.Title != "Le 360 en onglets v2" || got.Renamed {
		t.Errorf("an empty rename goes back to the automatic title: %+v", got)
	}
}

// TC-MAT-002 (Codex): its apply_patch additions are work files, its answer names a file (copied) and an address (a
// link material).
func TestCodexPatchFixture(t *testing.T) {
	h := makeHarness(t)
	h.r.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		return molten.AgentRunInfo{BlockId: blockId, Agent: molten.AgentIdCodex, FirstName: "Léon", Running: true}, true
	}
	h.write("notes/plan-1301.md", "# Plan de découpage #1301\n\nSteps.\n")
	h.write("notes/draft.md", "draft\n")
	tr := h.codexTranscript("codex-patch.jsonl")
	h.poll(tr, molten.AgentIdCodex)
	list := h.list()
	if len(list) != 2 {
		t.Fatalf("want the named plan and the link, got %+v", list)
	}
	plan := byOriginalName(list, "plan-1301.md")
	if plan == nil || plan.Title != "Plan de découpage #1301" || plan.Kind != molten.MaterialKindText || plan.Copy != molten.MaterialCopyKept {
		t.Fatalf("plan: %+v", plan)
	}
	if plan.Tool != molten.AgentIdCodex || plan.Agent != "Léon" || plan.Ticket != 1301 {
		t.Errorf("plan record: %+v", plan)
	}
	link := byLink(list, "https://claude.ai/code/artifact/CodexDemo42")
	if link == nil || link.Kind != molten.MaterialKindLink || len(link.Versions) != 0 || link.Copy != "" {
		t.Errorf("link: %+v", link)
	}
	work, _ := h.r.store.WorkFiles(h.key())
	if len(work) != 1 || filepath.Base(work[0].Path) != "draft.md" {
		t.Errorf("work files: %+v", work)
	}
}

// AC2: a session that writes 280 files and publishes 3 pages gives 3 materials and 277 work files.
func TestOnlyShownFilesAreMaterials(t *testing.T) {
	h := makeHarness(t)
	s := companion.MakeLeanSession()
	for i := 0; i < 280; i++ {
		path := h.write(fmt.Sprintf("work/page-%03d.html", i), fmt.Sprintf("<title>Page %d</title>", i))
		s.AddFileEdit(path, companion.FileAdded, "", int64(1000+i))
	}
	for i := 0; i < 3; i++ {
		path := filepath.Join(h.dir, fmt.Sprintf("work/page-%03d.html", i*100))
		s.NotePublication(companion.Publication{Path: path, Url: fmt.Sprintf("https://claude.ai/artifact/Page%d", i), Title: fmt.Sprintf("Page %d", i), ArtifactId: fmt.Sprintf("aid-%d", i)}, 5000)
	}
	h.feedSession(s)
	if n := len(h.list()); n != 3 {
		t.Fatalf("want 3 materials, got %d", n)
	}
	work, _ := h.r.store.WorkFiles(h.key())
	if len(work) != 277 {
		t.Fatalf("want 277 work files, got %d", len(work))
	}
	for _, w := range work {
		if !w.MayBeLost {
			t.Fatalf("a work file under a temporary folder may be lost: %+v", w)
		}
	}
	// A work file whose file is gone leaves no line.
	os.Remove(work[0].Path)
	if work, _ := h.r.store.WorkFiles(h.key()); len(work) != 276 {
		t.Errorf("a removed work file is still listed: %d", len(work))
	}
}

// Signal 5: a declared file is copied, a declared address is a link cleaned of its sensitive parameters, a signed
// address that expires is not kept.
func TestDeclare(t *testing.T) {
	h := makeHarness(t)
	path := h.write("report.md", "# Weekly report\n")
	m, err := h.r.Add("block-1", "", path, "", "", false, molten.MaterialSourceDeclared)
	if err != nil || m.Title != "Weekly report" || m.Copy != molten.MaterialCopyKept || m.Source != molten.MaterialSourceDeclared {
		t.Fatalf("declared file: %+v %v", m, err)
	}
	again, err := h.r.Add("block-1", "", "report.md", h.dir, "Report", false, molten.MaterialSourceDeclared)
	if err != nil || again.Id != m.Id || len(again.Versions) != 1 {
		t.Errorf("a file declared twice is one material, one version: %+v %v", again, err)
	}
	if again.Title != "Report" {
		t.Errorf("the declared title wins: %q", again.Title)
	}
	l, err := h.r.Add("block-1", "", "https://docs.example.com/d/abc?id=1&access_token=SECRET&sig=x", "", "Spec", false, molten.MaterialSourceDeclared)
	if err != nil || l.Link != "https://docs.example.com/d/abc?id=1" || l.Title != "Spec" {
		t.Errorf("cleaned link: %+v %v", l, err)
	}
	if _, err := h.r.Add("block-1", "", "https://bucket.s3.amazonaws.com/x.pdf?X-Amz-Expires=300&X-Amz-Signature=abc", "", "", false, molten.MaterialSourceDeclared); err == nil {
		t.Errorf("a signed expiring address is not kept")
	}
	if _, err := h.r.Add("block-1", "", "notes.txt", "", "", false, molten.MaterialSourceDeclared); err == nil {
		t.Errorf("a relative path without a folder is refused")
	}
	for _, m := range h.list() {
		if strings.Contains(m.Link, "SECRET") {
			t.Errorf("a token reached the index: %s", m.Link)
		}
	}
}

// TC-MAT-003: over the limit a material is a reference; a requested copy has the higher limit.
func TestTooLarge(t *testing.T) {
	h := makeHarness(t)
	h.r.limits.AutoCopy = 1000
	h.r.limits.RequestedCopy = 10000
	path := h.write("demo/parcours.mp4", strings.Repeat("v", 5000))
	m, err := h.r.Add("block-1", "", path, "", "", false, molten.MaterialSourceNamed)
	if err != nil || m.Copy != molten.MaterialCopyTooLarge || len(m.Versions) != 0 || m.Size != 5000 || m.Original == "" {
		t.Fatalf("too large: %+v %v", m, err)
	}
	m, err = h.r.Copy("", m.Id, true, false)
	if err != nil || m.Copy != molten.MaterialCopyKept || len(m.Versions) != 1 {
		t.Fatalf("requested copy: %+v %v", m, err)
	}
}

// TC-MAT-003, NFR-MAT-002: a full cap makes references and removes nothing.
func TestCapsNeverEvict(t *testing.T) {
	h := makeHarness(t)
	h.r.limits.ProjectCap = 3000
	a := h.write("a.txt", strings.Repeat("a", 2000))
	b := h.write("b.txt", strings.Repeat("b", 2000))
	ma, _ := h.r.Add("block-1", "", a, "", "", false, molten.MaterialSourceNamed)
	mb, _ := h.r.Add("block-1", "", b, "", "", false, molten.MaterialSourceNamed)
	if ma.Copy != molten.MaterialCopyKept || mb.Copy != molten.MaterialCopySpaceFull || len(mb.Versions) != 0 {
		t.Fatalf("caps: %+v / %+v", ma, mb)
	}
	got, _ := h.r.store.Get("", ma.Id)
	if len(got.Versions) != 1 {
		t.Errorf("an existing copy was removed: %+v", got)
	}
	usage := h.r.store.Usage(h.key(), h.r.limits)
	if usage.Project != 2000 || usage.Full {
		t.Errorf("usage %+v", usage)
	}
	// The total cap counts every drawer.
	h.r.limits.ProjectCap = 1 << 30
	h.r.limits.TotalCap = 3000
	h.project = filepath.Join(filepath.Dir(h.project), "other")
	os.MkdirAll(h.project, 0o755)
	h.r.ForgetBlock("block-1")
	c := h.write("c.txt", strings.Repeat("c", 2000))
	mc, _ := h.r.Add("block-1", "", c, "", "", false, molten.MaterialSourceNamed)
	if mc.Copy != molten.MaterialCopySpaceFull {
		t.Errorf("the total cap: %+v", mc)
	}
}

// AC9: five versions, the first and the four most recent; a pruned one goes to the trash.
func TestVersionsKeepFirstAndRecent(t *testing.T) {
	h := makeHarness(t)
	var id string
	for i := 1; i <= 7; i++ {
		path := h.write("notes.md", fmt.Sprintf("# Notes\n\nversion %d\n", i))
		m, err := h.r.Add("block-1", "", path, "", "", false, molten.MaterialSourceDeclared)
		if err != nil {
			t.Fatal(err)
		}
		id = m.Id
	}
	m, _ := h.r.store.Get("", id)
	var ns []int
	for _, v := range m.Versions {
		ns = append(ns, v.N)
	}
	if fmt.Sprint(ns) != "[1 4 5 6 7]" {
		t.Fatalf("versions %v", ns)
	}
	trash, _ := os.ReadDir(filepath.Join(h.root, h.key(), deletedDir))
	if len(trash) != 2 {
		t.Errorf("two pruned versions in the trash, got %d", len(trash))
	}
	first := filepath.Join(h.root, h.key(), itemsDir, id, m.Versions[0].Dir, "notes.md")
	if data, _ := os.ReadFile(first); !strings.Contains(string(data), "version 1") {
		t.Errorf("the first version changed: %q", data)
	}
}

// TC-MAT-004: a page with a private key is not copied, "Keep anyway" copies it; a linked file with a token too.
func TestSecretsHoldTheCopy(t *testing.T) {
	h := makeHarness(t)
	key := "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"
	page := h.write("leak/report.html", "<title>Report</title><pre>"+key+"</pre>")
	m, err := h.r.Add("block-1", "", page, "", "", false, molten.MaterialSourceNamed)
	if err != nil || m.Copy != molten.MaterialCopySecret || len(m.Versions) != 0 {
		t.Fatalf("secret page: %+v %v", m, err)
	}
	if data, _ := os.ReadFile(page); !strings.Contains(string(data), "PRIVATE KEY") {
		t.Errorf("the detection changed the file")
	}
	m, err = h.r.Copy("", m.Id, false, true)
	if err != nil || m.Copy != molten.MaterialCopyKept {
		t.Fatalf("keep anyway: %+v %v", m, err)
	}
	h.write("leak2/style.css", "body{} /* ghp_abcdefghijklmnopqrstuvwxyz0123 */")
	page2 := h.write("leak2/index.html", `<title>Two</title><link href="style.css" rel="stylesheet">`)
	m2, _ := h.r.Add("block-1", "", page2, "", "", false, molten.MaterialSourceNamed)
	if m2.Copy != molten.MaterialCopySecret {
		t.Errorf("a linked file's token holds the copy: %+v", m2)
	}
	// A binary file is checked for the forbidden paths only.
	bin := h.write("leak3/shot.png", "PNG -----BEGIN RSA PRIVATE KEY----- x -----END RSA PRIVATE KEY-----")
	m3, _ := h.r.Add("block-1", "", bin, "", "", false, molten.MaterialSourceNamed)
	if m3.Copy != molten.MaterialCopyKept {
		t.Errorf("binary: %+v", m3)
	}
}

// TC-MAT-004, AC14: the forbidden paths are never copied nor listed, through a link too.
func TestForbiddenPaths(t *testing.T) {
	h := makeHarness(t)
	ssh := filepath.Join(h.home, ".ssh", "report.html")
	os.MkdirAll(filepath.Dir(ssh), 0o700)
	os.WriteFile(ssh, []byte("<title>x</title>"), 0o600)
	os.MkdirAll(filepath.Join(h.home, ".claude", "projects"), 0o700)
	claudeFile := filepath.Join(h.home, ".claude", "projects", "brief.md")
	os.WriteFile(claudeFile, []byte("# brief"), 0o600)
	own := filepath.Join(filepath.Dir(filepath.Dir(h.root)), "brief.md")
	os.WriteFile(own, []byte("# brief"), 0o600)
	link := filepath.Join(h.dir, "innocent.html")
	os.Symlink(ssh, link)
	for _, p := range []string{ssh, claudeFile, own, link, h.write("id_rsa.png", "x"), h.write("cert.pem", "x"), h.write("site/.env.local.txt", "x")} {
		if m, err := h.r.Add("block-1", "", p, "", "", false, molten.MaterialSourceNamed); err == nil {
			t.Errorf("%s was kept: %+v", p, m)
		}
	}
	// Named in an answer: nothing at all.
	s := companion.MakeLeanSession()
	s.StartTurn(1)
	s.AddText("See "+ssh+" and "+link, 2)
	s.EndTurn()
	h.feedSession(s)
	// Published from a forbidden path: the link alone.
	s = companion.MakeLeanSession()
	s.NotePublication(companion.Publication{Path: ssh, Url: "https://claude.ai/artifact/Forbidden1", Title: "Secret page"}, 3)
	h.feedSession(s)
	list := h.list()
	if len(list) != 1 || list[0].Original != "" || len(list[0].Versions) != 0 || list[0].Link == "" {
		t.Fatalf("forbidden: %+v", list)
	}
	// A page's linked file that is a link to a forbidden folder is skipped.
	os.MkdirAll(filepath.Join(h.home, ".ssh", "img"), 0o700)
	os.WriteFile(filepath.Join(h.home, ".ssh", "img", "k.png"), []byte("png"), 0o600)
	os.MkdirAll(filepath.Join(h.dir, "page"), 0o755)
	os.Symlink(filepath.Join(h.home, ".ssh", "img", "k.png"), filepath.Join(h.dir, "page", "k.png"))
	page := h.write("page/index.html", `<title>P</title><img src="k.png">`)
	m, err := h.r.Add("block-1", "", page, "", "", false, molten.MaterialSourceNamed)
	if err != nil || m.Files != 0 {
		t.Errorf("linked forbidden file: %+v %v", m, err)
	}
}

// AC12: never a material: code, json/yaml/toml, a file git tracks; a git-ignored file is.
func TestNeverList(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	h := makeHarness(t)
	for _, p := range []string{h.write("main.go", "package main"), h.write("conf.json", "{}"), h.write("conf.yaml", "a: 1"), h.write("a.toml", "x=1"), h.write("a.zip", "PK")} {
		if _, err := h.r.Add("block-1", "", p, "", "", false, molten.MaterialSourceNamed); err == nil {
			t.Errorf("%s was kept", p)
		}
	}
	repo := filepath.Join(h.dir, "repo")
	os.MkdirAll(repo, 0o755)
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	run("init", "-q")
	os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("out/\n"), 0o644)
	os.WriteFile(filepath.Join(repo, "README.md"), []byte("# Readme"), 0o644)
	os.MkdirAll(filepath.Join(repo, "out"), 0o755)
	os.WriteFile(filepath.Join(repo, "out", "report.md"), []byte("# Built report"), 0o644)
	run("add", "README.md", ".gitignore")
	if _, err := h.r.Add("block-1", "", filepath.Join(repo, "README.md"), "", "", false, molten.MaterialSourceNamed); err == nil {
		t.Errorf("a tracked file was kept")
	}
	m, err := h.r.Add("block-1", "", filepath.Join(repo, "out", "report.md"), "", "", false, molten.MaterialSourceNamed)
	if err != nil || m.Title != "Built report" {
		t.Errorf("an ignored file is outside the repository: %+v %v", m, err)
	}
}

// AC1: a worktree's materials go to its main repository's drawer.
func TestWorktreeMapsToMainRepository(t *testing.T) {
	base := t.TempDir()
	main := filepath.Join(base, "MoltenTerm")
	wt := filepath.Join(main, ".claude", "worktrees", "agent-1")
	os.MkdirAll(filepath.Join(main, ".git", "worktrees", "agent-1"), 0o755)
	os.MkdirAll(filepath.Join(wt, "pkg"), 0o755)
	os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+filepath.Join(main, ".git", "worktrees", "agent-1")+"\n"), 0o644)
	os.WriteFile(filepath.Join(main, ".git", "worktrees", "agent-1", "commondir"), []byte("../..\n"), 0o644)
	km, rootMain := ProjectKey(main)
	kw, rootWt := ProjectKey(filepath.Join(wt, "pkg"))
	if km != kw || rootMain != main || rootWt != main {
		t.Fatalf("worktree %s (%s) vs main %s (%s)", kw, rootWt, km, rootMain)
	}
	if k, root := ProjectKey(""); k != molten.MaterialsNoProject || root != "" {
		t.Errorf("no project: %s %s", k, root)
	}
	if !validProjectKey(km) || validProjectKey("../x") {
		t.Errorf("key validation")
	}
}

// A workspace without a project has its own drawer.
func TestNoProjectDrawer(t *testing.T) {
	h := makeHarness(t)
	h.project = ""
	m, err := h.r.Add("block-1", "", h.write("a.md", "# A"), "", "", false, molten.MaterialSourceDeclared)
	if err != nil || m.Project != molten.MaterialsNoProject {
		t.Fatalf("%+v %v", m, err)
	}
	p, _ := h.r.store.Project(molten.MaterialsNoProject)
	if p.Folder != "" || p.Name != "" {
		t.Errorf("no project: %+v", p)
	}
}

// AC8: a material that may be lost is copied again at the end of the turn, when its page received its captures.
func TestEndOfTurnRecopy(t *testing.T) {
	h := makeHarness(t)
	page := h.write("late/index.html", `<title>Late</title><img src="cap.png">`)
	s := companion.MakeLeanSession()
	s.StartTurn(1)
	s.NotePublication(companion.Publication{Path: page, Url: "https://claude.ai/artifact/Late1", Title: "Late"}, 2)
	s.AddText("Here is the page: "+filepath.Join(h.dir, "late", "notes.md"), 3)
	h.feed(checkpoint.MaterialFeed{Batch: s.MaterialSignals(0)})
	h.write("late/notes.md", "# Notes")
	list := h.list()
	if len(list) != 1 || list[0].Files != 0 || !list[0].MayBeLost || len(list[0].Versions) != 1 {
		t.Fatalf("published page, and a path named before the turn's end is not read yet: %+v", list)
	}
	firstDir := list[0].Versions[0].Dir
	// The capture arrives, then the turn ends (the hook reports it): the copy is made again, as the same version.
	h.writePng("late/cap.png", 8, 8)
	h.feed(checkpoint.MaterialFeed{TurnEnded: true})
	got, _ := h.r.store.Get("", list[0].Id)
	if len(got.Versions) != 1 || got.Files != 1 || got.Versions[0].Dir == firstDir {
		t.Fatalf("recopy: %+v", got)
	}
	if entries, _ := os.ReadDir(filepath.Join(h.root, h.key(), itemsDir, got.Id)); len(entries) != 1 {
		t.Errorf("the replaced version's folder stayed: %d entries", len(entries))
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(got.CopyPath), "cap.png")); err != nil {
		t.Errorf("the recopy lacks the capture")
	}
	// The turn's materials were recopied once: a later end of turn without a sighting changes nothing.
	h.write("late/index.html", `<title>Late</title><img src="cap.png"><p>later</p>`)
	h.feed(checkpoint.MaterialFeed{TurnEnded: true})
	again, _ := h.r.store.Get("", got.Id)
	if again.Versions[0].Dir != got.Versions[0].Dir {
		t.Errorf("a material of an earlier turn was copied again")
	}
}

// Delete moves the copy to the trash; Undo restores it; the trash empties after 30 days.
func TestDeleteRestoreAndTrash(t *testing.T) {
	h := makeHarness(t)
	m, _ := h.r.Add("block-1", "", h.write("d.md", "# D"), "", "", false, molten.MaterialSourceDeclared)
	trashId, err := h.r.store.DeleteCopy("", m.Id)
	if err != nil || len(h.list()) != 0 {
		t.Fatalf("delete: %v %d", err, len(h.list()))
	}
	got, err := h.r.store.Restore("", trashId)
	if err != nil || got.Id != m.Id || len(h.list()) != 1 {
		t.Fatalf("restore: %+v %v", got, err)
	}
	if data, err := os.ReadFile(h.list()[0].CopyPath); err != nil || string(data) != "# D" {
		t.Errorf("restored copy: %q %v", data, err)
	}
	trashId, _ = h.r.store.DeleteCopy(h.key(), m.Id)
	now := time.Now()
	h.r.store.now = func() time.Time { return now.Add(29 * 24 * time.Hour) }
	h.r.store.Sweep(h.r.limits.TrashKeep)
	if _, err := os.Stat(filepath.Join(h.root, h.key(), deletedDir, trashId)); err != nil {
		t.Errorf("the trash kept less than 30 days")
	}
	h.r.store.now = func() time.Time { return now.Add(31 * 24 * time.Hour) }
	h.r.store.Sweep(h.r.limits.TrashKeep)
	if _, err := os.Stat(filepath.Join(h.root, h.key(), deletedDir, trashId)); err == nil {
		t.Errorf("the trash kept more than 30 days")
	}
}

func TestPinAndOrder(t *testing.T) {
	h := makeHarness(t)
	now := time.Now()
	h.r.store.now = func() time.Time { return now }
	a, _ := h.r.Add("block-1", "", h.write("a.md", "# A"), "", "", false, molten.MaterialSourceDeclared)
	h.r.store.now = func() time.Time { return now.Add(time.Minute) }
	b, _ := h.r.Add("block-1", "", h.write("b.md", "# B"), "", "", false, molten.MaterialSourceDeclared)
	if list := h.list(); list[0].Id != b.Id {
		t.Errorf("newest first")
	}
	h.r.store.Pin("", a.Id, true)
	if list := h.list(); list[0].Id != a.Id || !list[0].Pinned {
		t.Errorf("pinned first")
	}
}

// NFR-MAT-001: folders 0700, files 0600, everything under the registry's folder.
func TestPermissions(t *testing.T) {
	h := makeHarness(t)
	h.writeProposal()
	tr := h.claudeTranscript("claude-publish.jsonl")
	h.poll(tr, molten.AgentIdClaude)
	checkModes(t, h.root)
}

func checkModes(t *testing.T, root string) {
	t.Helper()
	filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, _ := d.Info()
		if path == root {
			return nil
		}
		if d.IsDir() && info.Mode().Perm() != dirMode {
			t.Errorf("%s: %v", path, info.Mode().Perm())
		}
		if !d.IsDir() && info.Mode().Perm() != fileMode {
			t.Errorf("%s: %v", path, info.Mode().Perm())
		}
		return nil
	})
}

// Signal 2 for an agent without an adapter, and for a remote terminal: the addresses its terminal printed.
func TestTerminalLinks(t *testing.T) {
	h := makeHarness(t)
	h.r.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		return molten.AgentRunInfo{BlockId: blockId, Agent: "gemini", FirstName: "Iris", Running: true}, true
	}
	reads := 0
	h.r.readTerm = func(blockId string, from int64, max int64) ([]byte, int64, int64, error) {
		reads++
		out := "\x1b[32mPublished\x1b[0m: \x1b]8;;https://claude.ai/artifact/TermLink1\x1b\\link\x1b]8;;\x1b\\ and https://github.com/o/r/issues/2\r\n"
		return []byte(out), from, from + int64(len(out)), nil
	}
	h.feed(checkpoint.MaterialFeed{Agent: "gemini", Unlinked: true})
	list := h.list()
	if len(list) != 1 || list[0].Link != "https://claude.ai/artifact/TermLink1" || list[0].Agent != "Iris" {
		t.Fatalf("terminal links: %+v", list)
	}
	// An agent with a transcript is read there, not in its terminal.
	h.feed(checkpoint.MaterialFeed{Agent: molten.AgentIdClaude, Unlinked: true})
	if reads != 1 {
		t.Errorf("a local Claude Code terminal was read")
	}
}

// AC15: a remote terminal's files are never materials, only addresses.
func TestRemoteOnlyLinks(t *testing.T) {
	h := makeHarness(t)
	h.remote = true
	page := h.write("remote/page.html", "<title>R</title>")
	s := companion.MakeLeanSession()
	s.NotePublication(companion.Publication{Path: page, Url: "https://claude.ai/artifact/Remote1", Title: "Remote"}, 1)
	s.StartTurn(2)
	s.AddText("Look at "+page, 3)
	s.EndTurn()
	h.feedSession(s)
	list := h.list()
	if len(list) != 1 || list[0].Original != "" || len(list[0].Versions) != 0 {
		t.Fatalf("remote: %+v", list)
	}
	if _, err := h.r.Add("block-1", "", page, "", "", false, molten.MaterialSourceDeclared); err == nil {
		t.Errorf("a remote terminal declared a file")
	}
}

// The worker processes what the updater feeds, in the background.
func TestWorkerFeeds(t *testing.T) {
	h := makeHarness(t)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		h.r.Run(stop)
		close(done)
	}()
	t.Cleanup(func() {
		close(stop)
		<-done
	})
	s := companion.MakeLeanSession()
	s.StartTurn(1)
	s.AddText("Published https://claude.ai/artifact/Worker1", 2)
	h.r.Feed(checkpoint.MaterialFeed{BlockId: "block-1", Agent: molten.AgentIdClaude, Batch: s.MaterialSignals(0)})
	deadline := time.Now().Add(time.Minute)
	for len(h.list()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(h.list()) != 1 {
		t.Fatalf("the worker did not keep the link")
	}
}

func TestAutoTitle(t *testing.T) {
	h := makeHarness(t)
	cases := []struct {
		kind, rel, content, tool, subject, want string
	}{
		{molten.MaterialKindPage, "a.html", "<title>  Audit &amp; plan </title>", "", "", "Audit & plan"},
		{molten.MaterialKindPage, "b.html", "<title>x</title>", "Thème Coulée", "", "Thème Coulée"},
		{molten.MaterialKindText, "plan.md", "intro\n## Plan de découpage\n", "", "", "Plan de découpage"},
		{molten.MaterialKindPdf, "r.pdf", "%PDF-1.4 /Title (Rapport \\(final\\)) /Author", "", "", "Rapport (final)"},
		{molten.MaterialKindVideo, "library-flash.mov", "x", "", "", "Library flash"},
		{molten.MaterialKindImage, "cut_01.png", "x", "", "Le 360 en onglets", "Cut 01 · Le 360 en onglets"},
		{molten.MaterialKindDocument, "q3-report.docx", "x", "", "", "Q3 report"},
	}
	for _, c := range cases {
		path := h.write(c.rel, c.content)
		if got := AutoTitle(c.kind, path, "", c.tool, c.subject); got != c.want {
			t.Errorf("%s: %q, want %q", c.rel, got, c.want)
		}
	}
}

func TestCleanAddress(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"https://claude.ai/artifact/Abc", "https://claude.ai/artifact/Abc", true},
		{"https://u:p@example.com/x?token=1&page=2", "https://example.com/x?page=2", true},
		{"https://example.com/x?API_KEY=1&Signature=2&sessionid=3", "https://example.com/x", true},
		{"https://storage.googleapis.com/b/o?X-Goog-Signature=1", "", false},
		{"https://acct.blob.core.windows.net/c/b?sv=2020&se=2026&sig=x", "", false},
		{"ftp://example.com/x", "", false},
		{"file:///etc/passwd", "", false},
	}
	for _, c := range cases {
		got, ok := CleanAddress(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: %q %v", c.in, got, ok)
		}
	}
}

func TestProductionAddresses(t *testing.T) {
	text := "See https://claude.ai/artifact/AbC1. and https://claude.ai/code/artifact/0b9e-uuid, not https://claude.ai/new nor https://github.com/o/r/issues/1 nor http://claude.ai/artifact/plain"
	got := ProductionAddresses(text)
	if fmt.Sprint(got) != "[https://claude.ai/artifact/AbC1 https://claude.ai/code/artifact/0b9e-uuid]" {
		t.Errorf("%v", got)
	}
}

func TestNamedPaths(t *testing.T) {
	text := "Here: /tmp/a/report.html. Also `/tmp/with space/shot.png`, (~/Desktop/rec.mov) and file:///tmp/x%20y.pdf; " +
		"a link https://claude.ai/artifact/X is not a path, nor a/relative/path.md"
	got := NamedPaths(text, "/home/u")
	want := "[/tmp/x y.pdf /tmp/with space/shot.png /tmp/a/report.html /home/u/Desktop/rec.mov]"
	if fmt.Sprint(got) != want {
		t.Errorf("%v\nwant %s", got, want)
	}
}

// NFR-MAT-004: a write cut at any point leaves an index that opens, no material without its files and no partial
// file visible as a material.
func TestKillPoints(t *testing.T) {
	setup := func(t *testing.T) *harness {
		h := makeHarness(t)
		h.writeProposal()
		return h
	}
	// The steps call the registry directly: the worker's panic handler would catch a kill and carry on, holding the
	// store's lock, where a real kill stops everything.
	scenario := func(h *harness) {
		h.r.context("block-1")
		c := h.r.who("block-1", molten.AgentIdClaude, h.r.blocks["block-1"])
		c.Source, c.Path, c.Link, c.ToolTitle, c.ArtifactId, c.Linked = molten.MaterialSourcePublished, filepath.Join(h.dir, "360", "proposal.html"), "https://claude.ai/artifact/Kill1", "Kill", "k1", []string{"shots/cut-01.png"}
		h.r.capture(c)
		h.r.Add("block-1", "", filepath.Join(h.dir, "360", "four-states.png"), "", "", false, molten.MaterialSourceNamed)
		list := h.list()
		if len(list) > 0 {
			h.r.store.DeleteCopy("", list[0].Id)
		}
	}
	// Count the kill points the scenario passes.
	probe := setup(t)
	var points []string
	probe.r.store.killPoint = func(p string) { points = append(points, p) }
	scenario(probe)
	if len(points) < 10 {
		t.Fatalf("want at least 10 kill points, got %d: %v", len(points), points)
	}
	for i := range points {
		t.Run(fmt.Sprintf("%02d-%s", i, points[i]), func(t *testing.T) {
			h := setup(t)
			hits := 0
			h.r.store.killPoint = func(p string) {
				if hits == i {
					panic("killed")
				}
				hits++
			}
			func() {
				defer func() { recover() }()
				scenario(h)
			}()
			// wavesrv starts again on the same folder.
			store := MakeStore(h.root)
			store.Sweep(DefaultLimits().TrashKeep)
			list, err := store.List(h.key())
			if err != nil {
				t.Fatalf("the index does not open: %v", err)
			}
			for _, m := range list {
				for _, v := range m.Versions {
					dir := filepath.Join(h.root, h.key(), itemsDir, m.Id, v.Dir)
					if _, err := os.Stat(filepath.Join(dir, v.Main)); err != nil {
						t.Errorf("material %s lists version %s without its file", m.Id, v.Dir)
					}
					if v.Main == "proposal.html" {
						if _, err := os.Stat(filepath.Join(dir, "shots", "cut-01.png")); err != nil {
							t.Errorf("material %s lacks a linked file", m.Id)
						}
					}
				}
			}
			if _, err := os.Stat(filepath.Join(h.root, h.key(), tmpDir)); err == nil {
				t.Errorf("a temporary folder stayed after the sweep")
			}
			filepath.WalkDir(filepath.Join(h.root, h.key()), func(path string, d os.DirEntry, err error) error {
				if err == nil && strings.HasPrefix(d.Name(), ".tmp-") {
					t.Errorf("a partial file stayed: %s", path)
				}
				return nil
			})
			items, _ := os.ReadDir(filepath.Join(h.root, h.key(), itemsDir))
			for _, e := range items {
				found := false
				for _, m := range list {
					found = found || m.Id == e.Name()
				}
				if !found {
					t.Errorf("an item the index does not name stayed: %s", e.Name())
				}
			}
		})
	}
}
