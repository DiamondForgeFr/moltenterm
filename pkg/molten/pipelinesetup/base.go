// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The setup builds on the committed pipeline (#1098): the files at origin/<trunk> (else the local trunk), read with git,
// never the working copy's, which anyone may have edited without committing. An uncommitted edit is reported, and
// only used when the developer chooses to include it.

// The top-level keys the setup sets up; every other key of the file stays byte for byte (FR-MC-036 AC2).
var OwnedKeys = []string{"versions", "branches", "release", "steps"}

type baseFiles struct {
	// The ref the committed files were read at ("origin/develop"), and its commit; both empty outside a git repository,
	// where the working copy is all there is.
	Ref    string
	Commit string
	Trunk  string
	// The committed files (nil when the commit has none) and the working copy's.
	Pipeline      []byte
	Record        []byte
	LocalPipeline []byte
	LocalRecord   []byte
}

func (b *baseFiles) uncommitted() bool {
	return !bytes.Equal(b.Pipeline, b.LocalPipeline) || !bytes.Equal(b.Record, b.LocalRecord)
}

// buildOn: the pipeline and the record the proposal is built on.
func (b *baseFiles) buildOn(includeLocal bool) ([]byte, []byte) {
	if includeLocal {
		return b.LocalPipeline, b.LocalRecord
	}
	return b.Pipeline, b.Record
}

func (s *Setup) git(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if s.Run == nil {
		return nil, errors.New("git is not available")
	}
	return s.Run(ctx, dir, "git", args...)
}

func (s *Setup) commitOf(ctx context.Context, dir string, ref string) string {
	out, err := s.git(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// committedFile reads a file at a commit; nil when the commit has none.
func (s *Setup) committedFile(ctx context.Context, dir string, commit string, rel string) ([]byte, error) {
	out, err := s.git(ctx, dir, "cat-file", "-s", commit+":"+rel)
	if err != nil {
		return nil, nil
	}
	var size int64
	if _, err := fmt.Sscan(strings.TrimSpace(string(out)), &size); err != nil {
		return nil, nil
	}
	if size > maxPipelineBytes {
		return nil, fmt.Errorf("%s is too large", rel)
	}
	data, err := s.git(ctx, dir, "cat-file", "blob", commit+":"+rel)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func readLocalRecord(dir string) []byte {
	path := filepath.Join(dir, filepath.FromSlash(RecordFile))
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxRecordBytes {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return data
}

// baseRefs: where the committed pipeline is read, the remote's trunk first.
func baseRefs(trunk string) []string {
	return []string{"origin/" + trunk, "refs/heads/" + trunk}
}

func (s *Setup) readBase(ctx context.Context, dir string) (*baseFiles, error) {
	local, err := readCurrent(dir)
	if err != nil {
		return nil, err
	}
	b := &baseFiles{Trunk: molten.ResolvedBranches(dir).Trunk, LocalPipeline: local, LocalRecord: readLocalRecord(dir)}
	for _, ref := range baseRefs(b.Trunk) {
		if commit := s.commitOf(ctx, dir, ref); commit != "" {
			b.Ref, b.Commit = strings.TrimPrefix(ref, "refs/heads/"), commit
			break
		}
	}
	if b.Commit == "" {
		b.Pipeline, b.Record = b.LocalPipeline, b.LocalRecord
		return b, nil
	}
	if b.Pipeline, err = s.committedFile(ctx, dir, b.Commit, molten.ProjectPipelineFile); err != nil {
		return nil, err
	}
	record, err := s.committedFile(ctx, dir, b.Commit, RecordFile)
	if err != nil || int64(len(record)) > maxRecordBytes {
		record = nil
	}
	b.Record = record
	return b, nil
}

// pipelineReport validates the text the setup builds on as the project's file; an absent file is not present.
func pipelineReport(dir string, data []byte) molten.PipelineReport {
	if data == nil {
		return molten.PipelineReport{Path: filepath.Join(dir, molten.ProjectPipelineFile), Errors: []string{}, Warnings: []string{}}
	}
	return molten.ValidatePipelineData(dir, data)
}

func recordFrom(data []byte) *Record {
	if data == nil {
		return nil
	}
	var rec Record
	if json.Unmarshal(data, &rec) != nil || rec.Template <= 0 {
		return nil
	}
	if rec.Steps == nil {
		rec.Steps = map[string]string{}
	}
	return &rec
}

func topLevelValues(data []byte) (map[string]json.RawMessage, error) {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(data, &values); err != nil {
		return nil, err
	}
	return values, nil
}

func sameJson(a, b json.RawMessage) bool {
	var ca, cb bytes.Buffer
	if json.Compact(&ca, a) != nil || json.Compact(&cb, b) != nil {
		return bytes.Equal(a, b)
	}
	return bytes.Equal(ca.Bytes(), cb.Bytes())
}

func owned(key string) bool {
	for _, k := range OwnedKeys {
		if k == key {
			return true
		}
	}
	return false
}

// MergeOwned takes from a proposed file only the keys the setup sets up and merges them onto the file the setup builds
// on, as the template's draft is (#1098): whatever else the proposal says (ci, name, icon...) is dropped and listed.
// Without a file, the new one starts with the schema and the project's name.
func MergeOwned(current []byte, proposed []byte, name string) ([]byte, []string, error) {
	values, err := topLevelValues(proposed)
	if err != nil {
		return nil, nil, fmt.Errorf("the proposal is not a JSON object: %w", err)
	}
	var kept map[string]json.RawMessage
	if len(bytes.TrimSpace(current)) > 0 {
		if kept, err = topLevelValues(current); err != nil {
			return nil, nil, err
		}
	}
	dropped := []string{}
	for key, value := range values {
		if owned(key) {
			continue
		}
		if kept == nil && (key == "schema" || key == "name") {
			continue
		}
		if before, ok := kept[key]; !ok || !sameJson(before, value) {
			dropped = append(dropped, key)
		}
	}
	for key := range kept {
		if _, ok := values[key]; !ok && !owned(key) {
			dropped = append(dropped, key)
		}
	}
	sort.Strings(dropped)
	var merge []keyValue
	for _, key := range OwnedKeys {
		if value, ok := values[key]; ok {
			merge = append(merge, keyValue{Key: key, Value: value})
		}
	}
	base := []keyValue{{Key: "schema", Value: molten.PipelineSchema}, {Key: "name", Value: name}}
	out, err := MergeTopLevel(current, base, merge)
	if err != nil {
		return nil, nil, err
	}
	return out, dropped, nil
}
