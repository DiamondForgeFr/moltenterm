// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func fakeGhView(answer string, seen *[]string) func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		*seen = append(*seen, name+" "+strings.Join(args, " "))
		if answer == "" {
			return nil, errors.New("gh: not signed in")
		}
		return []byte(answer), nil
	}
}

func TestReadSetupPrStatus(t *testing.T) {
	var seen []string
	answer := `{"number": 42, "url": "https://github.com/o/r/pull/42", "state": "OPEN", "isDraft": true,
		"headRefName": "feature/7-release-pipeline", "baseRefName": "develop", "statusCheckRollup": [
		{"name": "test", "workflowName": "Tests", "status": "IN_PROGRESS", "conclusion": ""},
		{"name": "lint", "workflowName": "Tests", "status": "COMPLETED", "conclusion": "SUCCESS"}]}`
	got, err := ReadSetupPrStatus(context.Background(), fakeGhView(answer, &seen), SetupPrStatusRequest{Dir: "/tmp/p", Number: 42})
	if err != nil {
		t.Fatal(err)
	}
	if got.State != SetupPrStatusOpen || !got.Draft || got.Checks != ReviewCheckPending || got.Pending != 1 || got.Success != 1 {
		t.Fatalf("status: %+v", got)
	}
	if len(seen) != 1 || !strings.HasPrefix(seen[0], "gh pr view 42 --json ") {
		t.Fatalf("gh calls: %v", seen)
	}

	merged := `{"number": 42, "state": "MERGED", "isDraft": false, "statusCheckRollup": [{"name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"}]}`
	got, err = ReadSetupPrStatus(context.Background(), fakeGhView(merged, &seen), SetupPrStatusRequest{Dir: "/tmp/p", Number: 42})
	if err != nil || got.State != SetupPrStatusMerged || got.Checks != ReviewCheckSuccess {
		t.Fatalf("merged: %+v %v", got, err)
	}

	if _, err := ReadSetupPrStatus(context.Background(), fakeGhView("", &seen), SetupPrStatusRequest{Dir: "/tmp/p", Number: 42}); err == nil {
		t.Fatal("a gh failure is an error")
	}
	if _, err := ReadSetupPrStatus(context.Background(), fakeGhView(merged, &seen), SetupPrStatusRequest{Dir: "/tmp/p", Number: 7}); err == nil {
		t.Fatal("an answer about another pull request is refused")
	}
	if _, err := ReadSetupPrStatus(context.Background(), fakeGhView(merged, &seen), SetupPrStatusRequest{Dir: "relative", Number: 42}); err == nil {
		t.Fatal("a relative folder is refused")
	}
}
