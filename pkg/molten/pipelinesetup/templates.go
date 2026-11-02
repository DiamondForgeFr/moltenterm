// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Step 4 of the pipeline setup stepper (FR-MC-042): the pipeline prepared at step 3 saved as a template on this
// computer, in MoltenTerm's data folder and never in a repository (decision on #1093), then offered at step 2b of a
// later setup. A template holds the flow choices and the hand steps, never a path, a file or a secret of the project:
// what belongs to the project is filled in on the next one.

const (
	NeedType      = "type"
	NeedBranches  = "branches"
	NeedProtected = "protected"
	NeedTarget    = "target"
	NeedWorkflow  = "workflow"

	maxTemplates        = 100
	maxTemplateBytes    = 64 << 10
	maxTemplateName     = 80
	maxTemplateManual   = 30
	maxManualTitleBytes = 200
	maxManualTextBytes  = 4 << 10
)

var templatesLock sync.Mutex

var templateIdRegex = regexp.MustCompile(`^[0-9a-f]{16}$`)
var tagPrefixRegex = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._/-]{0,30}$|^$`)
var manualIdRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

// The flow a template keeps: the choices of the release chain, not the project's files.
type TemplateFlow struct {
	BranchModel string `json:"branchmodel"`
	// Tags on the trunk: no published branch of its own.
	Single bool `json:"single"`
	// The published branch's name where it was saved, used when the next project has none of its own.
	Release   string `json:"release,omitempty"`
	Merge     string `json:"merge"`
	TagPrefix string `json:"tagprefix"`
	RcFormat  string `json:"rcformat"`
	Rc        string `json:"rc"`
	Notes     bool   `json:"notes"`
	SyncBack  bool   `json:"syncback"`
	Milestone bool   `json:"milestone"`
	// Kept only when the developer ticks them.
	Publish []string     `json:"publish"`
	Manual  []ManualStep `json:"manual"`
}

type PipelineTemplate struct {
	Id      string `json:"id"`
	Name    string `json:"name"`
	AppType string `json:"apptype"`
	// The name of the project it was saved from, shown on the card.
	From    string       `json:"from"`
	SavedAt int64        `json:"savedat"`
	Flow    TemplateFlow `json:"flow"`
}

type TemplateSaveRequest struct {
	Dir     string  `json:"dir"`
	Name    string  `json:"name"`
	AppType string  `json:"apptype"`
	Options Options `json:"options"`
	// What is kept besides the flow (both ticked by default).
	KeepManual  bool `json:"keepmanual"`
	KeepPublish bool `json:"keeppublish"`
}

type TemplateSaveAnswer struct {
	Template PipelineTemplate `json:"template"`
}

type TemplatesRequest struct {
	Dir string `json:"dir"`
	// The type confirmed at step 1.
	AppType string `json:"apptype"`
}

// One check of a template against the project: Ok, or what happens without it.
type TemplateNeed struct {
	Code   string `json:"code"`
	Ok     bool   `json:"ok"`
	Target string `json:"target,omitempty"`
	Value  string `json:"value,omitempty"`
}

type TemplateFit struct {
	Template PipelineTemplate `json:"template"`
	Needs    []TemplateNeed   `json:"needs"`
	Met      int              `json:"met"`
	Total    int              `json:"total"`
	SameType bool             `json:"sametype"`
	// The template's choices adapted to this project, as step 2b applies them.
	Options Options `json:"options"`
}

type TemplatesAnswer struct {
	Templates []TemplateFit `json:"templates"`
}

type TemplateDeleteRequest struct {
	Id string `json:"id"`
}

type TemplateDeleteAnswer struct {
	Deleted bool `json:"deleted"`
}

func (s *Setup) templatePath(id string) (string, error) {
	if s.TemplatesDir == "" {
		return "", fmt.Errorf("pipeline templates are not available")
	}
	if !templateIdRegex.MatchString(id) {
		return "", fmt.Errorf("not a pipeline template id: %q", id)
	}
	return filepath.Join(s.TemplatesDir, id+".json"), nil
}

func newTemplateId() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func validBranchModel(m string) bool {
	return m == BranchModelPromote || m == BranchModelSingle || m == BranchModelRcPr
}

func validMerge(m string) bool {
	return m == MergeCommit || m == MergeSquash || m == MergeRebase
}

func validRcFormat(f string) bool {
	return f == RcFormatNumeric || f == RcFormatRcDot
}

// checkTemplate refuses anything the stepper could not have saved; a template read back is checked the same way.
func checkTemplate(t PipelineTemplate) error {
	if !templateIdRegex.MatchString(t.Id) {
		return fmt.Errorf("not a pipeline template id: %q", t.Id)
	}
	if !validAppType(t.AppType) || utf8.RuneCountInString(t.From) > maxTemplateName {
		return fmt.Errorf("not a pipeline template: type %q", t.AppType)
	}
	f := t.Flow
	if !validBranchModel(f.BranchModel) || !validMerge(f.Merge) || !validRcFormat(f.RcFormat) || !validRc(f.Rc) || !tagPrefixRegex.MatchString(f.TagPrefix) {
		return fmt.Errorf("not a pipeline template: unknown choice")
	}
	if f.Release != "" && !validBranchName(f.Release) {
		return fmt.Errorf("not a pipeline template: branch %q", f.Release)
	}
	for _, target := range f.Publish {
		if !hasChannel(DescribeTargets, target) {
			return fmt.Errorf("not a pipeline template: target %q", target)
		}
	}
	if len(f.Manual) > maxTemplateManual {
		return fmt.Errorf("not a pipeline template: too many steps by hand")
	}
	for _, m := range f.Manual {
		if !manualIdRegex.MatchString(m.Id) || strings.TrimSpace(m.Title) == "" || len(m.Title) > maxManualTitleBytes || len(m.Text) > maxManualTextBytes {
			return fmt.Errorf("not a pipeline template: step by hand %q", m.Id)
		}
		if m.Channel != "" && m.Channel != ChannelRc && m.Channel != ChannelPublic {
			return fmt.Errorf("not a pipeline template: channel %q", m.Channel)
		}
		if m.Before != "" && !manualIdRegex.MatchString(m.Before) {
			return fmt.Errorf("not a pipeline template: step %q", m.Before)
		}
	}
	return nil
}

// flowOf keeps the options' choices; on path 2a the release candidate answer and the targets are read from the
// project, as the options do not say them.
func flowOf(f Facts, o Options, keepManual bool, keepPublish bool) TemplateFlow {
	flow := TemplateFlow{BranchModel: o.BranchModel, Merge: o.Merge, TagPrefix: o.TagPrefix, RcFormat: o.RcFormat,
		Notes: o.Notes, SyncBack: o.SyncBack, Milestone: o.Milestone, Publish: []string{}, Manual: []ManualStep{}}
	trunk, release := f.Branches.Trunk, f.Branches.Release
	if validBranchName(o.Trunk) {
		trunk = o.Trunk
	}
	if validBranchName(o.Release) {
		release = o.Release
	}
	flow.Single = o.BranchModel == BranchModelSingle || trunk == release
	if flow.Single {
		flow.BranchModel = BranchModelSingle
		flow.SyncBack = false
	} else if validBranchName(release) {
		flow.Release = release
	}
	switch {
	case o.Described():
		flow.Rc = o.Rc
	case !hasChannel(o.Channels, ChannelRc):
		flow.Rc = RcNone
	case rcPublished(f, o):
		flow.Rc = RcPublished
	default:
		flow.Rc = RcInternal
	}
	if keepPublish {
		if o.Described() {
			for _, target := range DescribeTargets {
				if hasChannel(o.Publish, target) {
					flow.Publish = append(flow.Publish, target)
				}
			}
		} else {
			prefix := o.TagPrefix
			if prefix == "" {
				prefix = f.TagPrefix
			}
			for _, target := range DescribeTargets {
				if publishedBy(f, target, prefix) != "" {
					flow.Publish = append(flow.Publish, target)
				}
			}
		}
	}
	if keepManual {
		for _, m := range o.Manual {
			flow.Manual = append(flow.Manual, ManualStep{Id: m.Id, Title: strings.TrimSpace(m.Title), Text: m.Text, Channel: m.Channel, Before: m.Before})
		}
	}
	return flow
}

// SaveTemplate keeps the pipeline's flow on this computer; nothing of the project is written or copied.
func (s *Setup) SaveTemplate(ctx context.Context, req TemplateSaveRequest) (TemplateSaveAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return TemplateSaveAnswer{}, err
	}
	if s.TemplatesDir == "" {
		return TemplateSaveAnswer{}, fmt.Errorf("pipeline templates are not available")
	}
	name := strings.Join(strings.Fields(req.Name), " ")
	if name == "" || utf8.RuneCountInString(name) > maxTemplateName {
		return TemplateSaveAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.templateName", "max", fmt.Sprint(maxTemplateName)), "a template needs a name of %d characters at most", maxTemplateName)
	}
	if req.Options.Kind == KindSaas || req.AppType == AppTypeWeb {
		return TemplateSaveAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.templateSaas"), "a deployed (web or SaaS) pipeline cannot be saved as a template yet")
	}
	b, err := s.readBase(ctx, dir)
	if err != nil {
		return TemplateSaveAnswer{}, err
	}
	f := DetectWith(dir, pipelineReport(dir, b.Pipeline))
	id, err := newTemplateId()
	if err != nil {
		return TemplateSaveAnswer{}, err
	}
	from := f.Name
	if from == "" {
		from = filepath.Base(dir)
	}
	if utf8.RuneCountInString(from) > maxTemplateName {
		from = string([]rune(from)[:maxTemplateName])
	}
	t := PipelineTemplate{Id: id, Name: name, AppType: req.AppType, From: from, SavedAt: time.Now().UnixMilli(),
		Flow: flowOf(f, req.Options, req.KeepManual, req.KeepPublish)}
	if err := checkTemplate(t); err != nil {
		return TemplateSaveAnswer{}, err
	}
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return TemplateSaveAnswer{}, err
	}
	if len(data) > maxTemplateBytes {
		return TemplateSaveAnswer{}, fmt.Errorf("the template is too large")
	}
	path, err := s.templatePath(id)
	if err != nil {
		return TemplateSaveAnswer{}, err
	}
	if err := s.writeTemplate(path, data); err != nil {
		return TemplateSaveAnswer{}, err
	}
	return TemplateSaveAnswer{Template: t}, nil
}

func (s *Setup) writeTemplate(path string, data []byte) error {
	templatesLock.Lock()
	defer templatesLock.Unlock()
	if len(s.readTemplatesLocked()) >= maxTemplates {
		return uimsg.Errorf(uimsg.Make("mission.setup.templatesFull", "max", fmt.Sprint(maxTemplates)), "there are already %d templates: forget one first", maxTemplates)
	}
	if err := os.MkdirAll(s.TemplatesDir, 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(s.TemplatesDir); err != nil || !info.IsDir() {
		return fmt.Errorf("%s is not a folder", s.TemplatesDir)
	}
	tmp, err := os.CreateTemp(s.TemplatesDir, ".template-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// readTemplatesLocked reads every valid template, newest first; a file that is not one is skipped.
func (s *Setup) readTemplatesLocked() []PipelineTemplate {
	rtn := []PipelineTemplate{}
	if s.TemplatesDir == "" {
		return rtn
	}
	entries, err := os.ReadDir(s.TemplatesDir)
	if err != nil {
		return rtn
	}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !templateIdRegex.MatchString(id) {
			continue
		}
		path := filepath.Join(s.TemplatesDir, e.Name())
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxTemplateBytes {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var t PipelineTemplate
		if json.Unmarshal(data, &t) != nil || t.Id != id || checkTemplate(t) != nil {
			continue
		}
		if t.Flow.Publish == nil {
			t.Flow.Publish = []string{}
		}
		if t.Flow.Manual == nil {
			t.Flow.Manual = []ManualStep{}
		}
		rtn = append(rtn, t)
	}
	sort.SliceStable(rtn, func(i, j int) bool { return rtn[i].SavedAt > rtn[j].SavedAt })
	return rtn
}

func (s *Setup) readTemplates() []PipelineTemplate {
	templatesLock.Lock()
	defer templatesLock.Unlock()
	return s.readTemplatesLocked()
}

// Templates lists the saved templates for the project at Dir, each checked against it and adapted to it: the same
// type first, then the best fit. Nothing is written.
func (s *Setup) Templates(ctx context.Context, req TemplatesRequest) (TemplatesAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return TemplatesAnswer{}, err
	}
	answer := TemplatesAnswer{Templates: []TemplateFit{}}
	list := s.readTemplates()
	if len(list) == 0 {
		return answer, nil
	}
	b, err := s.readBase(ctx, dir)
	if err != nil {
		return TemplatesAnswer{}, err
	}
	here := DetectWith(dir, pipelineReport(dir, b.Pipeline))
	ReadRemoteFacts(ctx, s.Run, dir, &here)
	for _, t := range list {
		answer.Templates = append(answer.Templates, FitTemplate(here, req.AppType, t))
	}
	sort.SliceStable(answer.Templates, func(i, j int) bool {
		a, c := answer.Templates[i], answer.Templates[j]
		if a.SameType != c.SameType {
			return a.SameType
		}
		return a.Met*c.Total > c.Met*a.Total
	})
	return answer, nil
}

func targetReachable(here Facts, target string) bool {
	if target == TargetNpm {
		return hasTarget(here, TargetNpm)
	}
	return here.OnGithub
}

// FitTemplate checks a template against the project and adapts its choices to it.
func FitTemplate(here Facts, appType string, t PipelineTemplate) TemplateFit {
	fit := TemplateFit{Template: t, Needs: []TemplateNeed{}, SameType: appType == "" || appType == t.AppType}
	add := func(n TemplateNeed) {
		fit.Needs = append(fit.Needs, n)
		fit.Total++
		if n.Ok {
			fit.Met++
		}
	}
	add(TemplateNeed{Code: NeedType, Ok: fit.SameType, Value: t.AppType})
	flow := t.Flow
	if !flow.Single {
		distinct := here.Branches.Release != "" && here.Branches.Release != here.Branches.Trunk
		value := here.Branches.Release
		if !distinct {
			value = flow.Release
		}
		add(TemplateNeed{Code: NeedBranches, Ok: distinct, Value: value})
	}
	if flow.BranchModel == BranchModelRcPr {
		add(TemplateNeed{Code: NeedProtected, Ok: here.Protection.RequiresPr(), Value: here.Branches.Release})
	}
	prefix := flow.TagPrefix
	if prefix == "" {
		prefix = here.TagPrefix
	}
	for _, target := range flow.Publish {
		if !targetReachable(here, target) {
			add(TemplateNeed{Code: NeedTarget, Ok: false, Target: target})
			continue
		}
		by := publishedBy(here, target, prefix)
		add(TemplateNeed{Code: NeedWorkflow, Ok: by != "", Target: target, Value: by})
	}
	fit.Options = TemplateOptions(here, t)
	return fit
}

// TemplateOptions applies a template's flow to the project as step 2b's description: this project's branches and
// files, the template's choices; a target the project cannot reach is dropped.
func TemplateOptions(here Facts, t PipelineTemplate) Options {
	flow := t.Flow
	o := DefaultOptions(here)
	o.Kind = KindOnPremise
	o.Merge = flow.Merge
	if flow.TagPrefix != "" {
		o.TagPrefix = flow.TagPrefix
	}
	o.RcFormat = flow.RcFormat
	o.Notes = flow.Notes
	o.Milestone = flow.Milestone && here.OnGithub
	o.Trunk = here.Branches.Trunk
	o.Release = here.Branches.Release
	if flow.Single {
		o.Release = o.Trunk
		o.BranchModel = BranchModelSingle
	} else {
		if o.Release == o.Trunk && flow.Release != "" && flow.Release != o.Trunk {
			o.Release = flow.Release
		}
		o.BranchModel = flow.BranchModel
	}
	o.SyncBack = flow.SyncBack && !flow.Single
	o.Reconcile = false
	o.Rc = flow.Rc
	o.Channels = []string{ChannelRc, ChannelPublic}
	if flow.Rc == RcNone {
		o.Channels = []string{ChannelPublic}
	}
	o.Publish = []string{}
	for _, target := range flow.Publish {
		if targetReachable(here, target) {
			o.Publish = append(o.Publish, target)
		}
	}
	o.Manual = append([]ManualStep{}, flow.Manual...)
	return o
}

// DeleteTemplate forgets a template; an unknown one is already forgotten.
func (s *Setup) DeleteTemplate(req TemplateDeleteRequest) (TemplateDeleteAnswer, error) {
	path, err := s.templatePath(req.Id)
	if err != nil {
		return TemplateDeleteAnswer{}, err
	}
	templatesLock.Lock()
	defer templatesLock.Unlock()
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return TemplateDeleteAnswer{}, nil
	}
	if err != nil {
		return TemplateDeleteAnswer{}, err
	}
	if !info.Mode().IsRegular() {
		return TemplateDeleteAnswer{}, fmt.Errorf("%s is not a template file", path)
	}
	if err := os.Remove(path); err != nil {
		return TemplateDeleteAnswer{}, err
	}
	return TemplateDeleteAnswer{Deleted: true}, nil
}
