// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

func markReadyService(err error) (*Service, *[][]string, *[]string) {
	var calls [][]string
	var dirs []string
	s := &Service{gh: func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		calls = append(calls, args)
		dirs = append(dirs, dir)
		return nil, err
	}}
	return s, &calls, &dirs
}

// AC3: Mark ready for review runs gh pr ready on the PR, naming the repository, in the project's folder.
func TestMarkReadyRunsGhPrReady(t *testing.T) {
	s, calls, dirs := markReadyService(nil)
	res, err := s.MarkReady(context.Background(), MarkReadyRequest{PrKey: PrKey{Repo: testRepo, Number: 12}, Dir: "/work/app"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != MarkReadyDone || res.Reason != "" {
		t.Errorf("result: %+v", res)
	}
	want := [][]string{{"pr", "ready", "12", "--repo", testRepo}}
	if !reflect.DeepEqual(*calls, want) || (*dirs)[0] != "/work/app" {
		t.Errorf("gh calls: %v in %v", *calls, *dirs)
	}
}

// AC4: gh's failures come back as a reason the window words, never as an RPC error.
func TestMarkReadyFailures(t *testing.T) {
	cases := []struct {
		err    error
		reason string
	}{
		{errors.New(`gh pr ready 12 --repo o/r: X Pull request o/r#12 is closed. Only draft pull requests can be marked as "ready for review"`), MarkReadyReasonClosed},
		{errors.New("gh pr ready 12 --repo o/r: GraphQL: Resource not accessible by integration (markPullRequestReadyForReview)"), MarkReadyReasonPermission},
		{errors.New("gh pr ready 12 --repo o/r: GraphQL: o-user does not have the correct permissions to execute `MarkPullRequestReadyForReview`"), MarkReadyReasonPermission},
		{errors.New("gh pr ready 12 --repo o/r: To get started with GitHub CLI, please run:  gh auth login"), MarkReadyReasonAuth},
		{errors.New("gh pr ready 12 --repo o/r: no pull requests found for branch \"12\""), MarkReadyReasonNotFound},
		{&mission.MissingProgramError{Name: "gh"}, MarkReadyReasonNoGh},
		{errors.New("gh pr ready 12 --repo o/r: dial tcp: lookup api.github.com: no such host"), MarkReadyReasonError},
	}
	for _, c := range cases {
		s, _, _ := markReadyService(c.err)
		res, err := s.MarkReady(context.Background(), MarkReadyRequest{PrKey: PrKey{Repo: testRepo, Number: 12}, Dir: "/work/app"})
		if err != nil {
			t.Fatalf("%v: RPC error %v", c.err, err)
		}
		if res.Status != MarkReadyFailed || res.Reason != c.reason {
			t.Errorf("%v: got %+v, want reason %s", c.err, res, c.reason)
		}
		if res.Message == "" {
			t.Errorf("%v: the message is lost", c.err)
		}
	}
}

func TestMarkReadyChecksTheRequest(t *testing.T) {
	s, calls, _ := markReadyService(nil)
	for _, req := range []MarkReadyRequest{
		{PrKey: PrKey{Repo: "not-a-repo", Number: 12}, Dir: "/work/app"},
		{PrKey: PrKey{Repo: testRepo, Number: 0}, Dir: "/work/app"},
		{PrKey: PrKey{Repo: testRepo, Number: 12}, Dir: "relative"},
	} {
		if _, err := s.MarkReady(context.Background(), req); err == nil {
			t.Errorf("%+v: accepted", req)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("gh ran on a bad request: %v", *calls)
	}
}
