// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The stepper's answers per project (FR-MC-038), in MoltenTerm's data, never in the repository: closing the setup and
// opening it again resumes where it was. They hold choices only.

const (
	StepDetect     = "detect"
	StepUnderstand = "understand"
	StepPrepare    = "prepare"
	StepTemplate   = "template"

	maxAnswersBytes = 256 << 10
)

var answersLock sync.Mutex

type Answers struct {
	Dir string `json:"dir"`
	// The committed pipeline's hash the step and the choices were made on.
	Base    string   `json:"base"`
	Step    string   `json:"step,omitempty"`
	AppType string   `json:"apptype,omitempty"`
	Path    string   `json:"path,omitempty"`
	Touched bool     `json:"touched,omitempty"`
	Options *Options `json:"options,omitempty"`
	SavedAt int64    `json:"savedat"`
}

// AnswersRequest saves the answers of the project at Dir; nil Answers clears them.
type AnswersRequest struct {
	Dir     string   `json:"dir"`
	Answers *Answers `json:"answers,omitempty"`
}

type AnswersAnswer struct {
	Saved bool `json:"saved"`
}

func (s *Setup) answersPath(dir string) string {
	if s.AnswersDir == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(dir))
	return filepath.Join(s.AnswersDir, hex.EncodeToString(sum[:12])+".json")
}

// loadAnswers reads the project's answers; the step and the choices are dropped when the committed pipeline changed
// since, the app type and the path kept.
func (s *Setup) loadAnswers(dir string, base string) *Answers {
	path := s.answersPath(dir)
	if path == "" {
		return nil
	}
	answersLock.Lock()
	defer answersLock.Unlock()
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxAnswersBytes {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var a Answers
	if json.Unmarshal(data, &a) != nil || a.Dir != dir {
		return nil
	}
	if a.Base != base {
		a.Base, a.Step, a.Touched, a.Options = base, "", false, nil
	}
	return &a
}

func validStep(step string) bool {
	return step == "" || step == StepDetect || step == StepUnderstand || step == StepPrepare || step == StepTemplate
}

// SaveAnswers keeps the stepper's answers for the project, or forgets them.
func (s *Setup) SaveAnswers(req AnswersRequest) (AnswersAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return AnswersAnswer{}, err
	}
	path := s.answersPath(dir)
	if path == "" {
		return AnswersAnswer{}, nil
	}
	if req.Answers == nil {
		answersLock.Lock()
		defer answersLock.Unlock()
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return AnswersAnswer{}, err
		}
		return AnswersAnswer{}, nil
	}
	a := *req.Answers
	if !validStep(a.Step) || (a.AppType != "" && !validAppType(a.AppType)) || (a.Path != "" && a.Path != PathAnalyse && a.Path != PathDescribe) {
		return AnswersAnswer{}, fmt.Errorf("not a pipeline setup answer: step %q, type %q, path %q", a.Step, a.AppType, a.Path)
	}
	a.Dir = dir
	a.SavedAt = time.Now().UnixMilli()
	data, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return AnswersAnswer{}, err
	}
	if len(data) > maxAnswersBytes {
		return AnswersAnswer{}, fmt.Errorf("the pipeline setup's answers are too large")
	}
	answersLock.Lock()
	defer answersLock.Unlock()
	if err := os.MkdirAll(s.AnswersDir, 0700); err != nil {
		return AnswersAnswer{}, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return AnswersAnswer{}, err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return AnswersAnswer{}, err
	}
	return AnswersAnswer{Saved: true}, nil
}
