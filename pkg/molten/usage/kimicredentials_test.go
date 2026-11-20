// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestKimiPaths(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "tester")
	env := func(values map[string]string) kimiEnvironment {
		return func(key string) (string, bool) {
			value, ok := values[key]
			return value, ok
		}
	}
	if got := kimiCredentialPath(env(nil), home); got != filepath.Join(home, ".kimi-code", "credentials", "kimi-code.json") {
		t.Errorf("default credentials: %s", got)
	}
	custom := filepath.Join(home, "custom")
	if got := kimiConfigPath(env(map[string]string{"KIMI_CODE_HOME": custom}), home); got != filepath.Join(custom, "config.toml") {
		t.Errorf("custom config: %s", got)
	}
	if got := kimiHome(env(map[string]string{"KIMI_CODE_HOME": ""}), home); got != filepath.Join(home, ".kimi-code") {
		t.Errorf("empty override: %s", got)
	}
}

func TestParseKimiCredentials(t *testing.T) {
	future := 1_800_000_000.125
	cases := []struct {
		name    string
		body    string
		token   string
		expires int64
		reason  string
	}{
		{"Unix seconds", fmt.Sprintf(`{"access_token":%q,"expires_at":%v,"refresh_token":"DO-NOT-READ"}`, fakeKimiToken, future), fakeKimiToken, int64(future * 1000), ""},
		{"missing expiry", fmt.Sprintf(`{"access_token":%q}`, fakeKimiToken), fakeKimiToken, 0, ""},
		{"zero expiry", fmt.Sprintf(`{"access_token":%q,"expires_at":0}`, fakeKimiToken), fakeKimiToken, 0, ""},
		{"whitespace", fmt.Sprintf(`{"access_token":"  %s  "}`, fakeKimiToken), fakeKimiToken, 0, ""},
		{"malformed JSON", `{`, "", 0, ReasonFormat},
		{"missing token", `{"refresh_token":"decoy"}`, "", 0, ReasonSignedOut},
		{"blank token", `{"access_token":"  "}`, "", 0, ReasonSignedOut},
		{"header injection", `{"access_token":"bad\r\nX-Evil: yes"}`, "", 0, ReasonSignedOut},
		{"negative expiry", fmt.Sprintf(`{"access_token":%q,"expires_at":-1}`, fakeKimiToken), "", 0, ReasonFormat},
		{"string expiry", fmt.Sprintf(`{"access_token":%q,"expires_at":"1800000000"}`, fakeKimiToken), "", 0, ReasonFormat},
		{"overflow expiry", fmt.Sprintf(`{"access_token":%q,"expires_at":1e300}`, fakeKimiToken), "", 0, ReasonFormat},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			token, expires, err := parseKimiCredentials([]byte(tc.body))
			if token != tc.token || expires != tc.expires || (tc.reason == "" && err != nil) || (tc.reason != "" && ReasonOf(err) != tc.reason) {
				t.Errorf("token=%q expires=%d err=%v", token, expires, err)
			}
		})
	}
}

func TestReadKimiCredentialsFileSafety(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "kimi-code.json")
	body := []byte(fmt.Sprintf(`{"access_token":%q,"expires_at":1800000000,"refresh_token":"decoy"}`, fakeKimiToken))
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	token, expires, err := readKimiCredentialsFile(path)
	if err != nil || token != fakeKimiToken || expires != 1_800_000_000_000 {
		t.Fatalf("read: %q %d %v", token, expires, err)
	}
	after, _ := os.Stat(path)
	contents, _ := os.ReadFile(path)
	if string(contents) != string(body) || !after.ModTime().Equal(before.ModTime()) {
		t.Error("the credential file changed")
	}
	for _, tc := range []struct {
		name   string
		path   string
		reason string
	}{
		{"missing", filepath.Join(dir, "missing"), ReasonSignedOut},
		{"directory", dir, ReasonSignedOut},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := readKimiCredentialsFile(tc.path); ReasonOf(err) != tc.reason {
				t.Errorf("err=%v", err)
			}
		})
	}
	t.Run("symlink", func(t *testing.T) {
		link := filepath.Join(dir, "link.json")
		if err := os.Symlink(path, link); err != nil {
			t.Skip(err)
		}
		if _, _, err := readKimiCredentialsFile(link); ReasonOf(err) != ReasonSignedOut {
			t.Errorf("err=%v", err)
		}
	})
	t.Run("FIFO", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("FIFOs are not available on Windows")
		}
		if _, err := exec.LookPath("mkfifo"); err != nil {
			t.Skip("mkfifo is not available")
		}
		fifo := filepath.Join(dir, "credentials.fifo")
		if err := exec.Command("mkfifo", fifo).Run(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			_, _, err := readKimiCredentialsFile(fifo)
			done <- err
		}()
		select {
		case err := <-done:
			if ReasonOf(err) != ReasonSignedOut {
				t.Errorf("err=%v", err)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("FIFO read blocked")
		}
	})
	t.Run("oversized", func(t *testing.T) {
		big := filepath.Join(dir, "big.json")
		if err := os.WriteFile(big, []byte(strings.Repeat("x", maxCredentialsBytes+1)), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := readKimiCredentialsFile(big); ReasonOf(err) != ReasonFormat {
			t.Errorf("err=%v", err)
		}
	})
}

func writeKimiConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const validKimiConfig = `
default_model = "kimi-code/k2.5"
[models."kimi-code/k2.5"]
provider = "managed:kimi-code"
[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1/"
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
oauth_host = "https://auth.kimi.com/"
`

func noKimiEnv(string) (string, bool) { return "", false }

func TestCheckKimiManagedConfig(t *testing.T) {
	valid := []struct {
		name string
		body string
		env  map[string]string
	}{
		{"official shared host", validKimiConfig, nil},
		{"official AI scoped host", strings.NewReplacer(
			"https://api.kimi.com/coding/v1/", "https://api.kimi.ai/coding/v1/",
			"https://auth.kimi.com/", "https://auth.kimi.ai/",
			`key = "oauth/kimi-code"`, `key = "oauth/kimi-code-env-prod"`,
		).Replace(validKimiConfig), nil},
		{"matching environment", validKimiConfig, map[string]string{"KIMI_CODE_OAUTH_HOST": "https://auth.kimi.com", "KIMI_CODE_BASE_URL": "https://api.kimi.com/coding/v1"}},
		{"API key is not decoded", strings.Replace(validKimiConfig, `base_url = "https://api.kimi.com/coding/v1/"`, "base_url = \"https://api.kimi.com/coding/v1/\"\napi_key = \"not-read\"", 1), nil},
	}
	for _, tc := range valid {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(key string) (string, bool) {
				value, ok := tc.env[key]
				return value, ok
			}
			if err := checkKimiManagedConfigAt(writeKimiConfig(t, tc.body), getenv); err != nil {
				t.Errorf("valid config: %v", err)
			}
		})
	}

	replacements := []struct {
		name string
		from string
		to   string
	}{
		{"custom model", `default_model = "kimi-code/k2.5"`, `default_model = "openai/gpt"`},
		{"custom provider", `provider = "managed:kimi-code"`, `provider = "custom"`},
		{"keyring storage", `storage = "file"`, `storage = "keyring"`},
		{"global AI OAuth host", `oauth_host = "https://auth.kimi.com/"`, `oauth_host = "https://auth.kimi.ai"`},
		{"custom base URL", `base_url = "https://api.kimi.com/coding/v1/"`, `base_url = "https://example.com/v1"`},
	}
	for _, tc := range replacements {
		t.Run(tc.name, func(t *testing.T) {
			body := strings.Replace(validKimiConfig, tc.from, tc.to, 1)
			if err := checkKimiManagedConfigAt(writeKimiConfig(t, body), noKimiEnv); ReasonOf(err) != ReasonUnsupported {
				t.Errorf("err=%v", err)
			}
		})
	}
	for _, tc := range []struct {
		name   string
		body   string
		reason string
	}{
		{"missing default", `[models]`, ReasonSignedOut},
		{"malformed", `not = [toml`, ReasonFormat},
		{"missing provider", `default_model = "kimi-code/k2.5"`, ReasonUnsupported},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := checkKimiManagedConfigAt(writeKimiConfig(t, tc.body), noKimiEnv); ReasonOf(err) != tc.reason {
				t.Errorf("err=%v", err)
			}
		})
	}
	for _, env := range []map[string]string{
		{"KIMI_CODE_OAUTH_HOST": "https://auth.kimi.ai"},
		{"KIMI_OAUTH_HOST": "https://auth.kimi.ai"},
		{"KIMI_CODE_BASE_URL": "https://api.kimi.ai/coding/v1"},
	} {
		getenv := func(key string) (string, bool) {
			value, ok := env[key]
			return value, ok
		}
		if err := checkKimiManagedConfigAt(writeKimiConfig(t, validKimiConfig), getenv); ReasonOf(err) != ReasonUnsupported {
			t.Errorf("environment %v: %v", env, err)
		}
	}
	if err := checkKimiManagedConfigAt(filepath.Join(t.TempDir(), "missing"), noKimiEnv); ReasonOf(err) != ReasonSignedOut {
		t.Errorf("missing config: %v", err)
	}
}

func TestReadKimiManagedConnection(t *testing.T) {
	home := t.TempDir()
	aiConfig := strings.NewReplacer(
		"https://api.kimi.com/coding/v1/", "https://api.kimi.ai/coding/v1/",
		"https://auth.kimi.com/", "https://auth.kimi.ai/",
		`key = "oauth/kimi-code"`, `key = "oauth/kimi-code-env-prod"`,
	).Replace(validKimiConfig)
	connection, err := readKimiManagedConfigAt(writeKimiConfig(t, aiConfig), noKimiEnv, home)
	if err != nil {
		t.Fatal(err)
	}
	wantCredential := filepath.Join(home, ".kimi-code", "credentials", "kimi-code-env-prod.json")
	if connection.credentialPath != wantCredential || connection.usageEndpoint != KimiAIUsageEndpoint || connection.pageURL != KimiAIUsagePageURL || connection.domain != "kimi.ai" {
		t.Errorf("AI connection: %+v", connection)
	}

	for _, key := range []string{"", "kimi-code", "oauth/..", "oauth/.hidden", "oauth/../other", "oauth/sub/file", `oauth/sub\file`} {
		t.Run("credential key "+key, func(t *testing.T) {
			body := strings.Replace(validKimiConfig, `key = "oauth/kimi-code"`, `key = "`+key+`"`, 1)
			if _, err := readKimiManagedConfigAt(writeKimiConfig(t, body), noKimiEnv, home); ReasonOf(err) != ReasonUnsupported {
				t.Errorf("key %q: %v", key, err)
			}
		})
	}
}

func TestKimiManagedChangeClearsCachedValuesBeforeCredentialRead(t *testing.T) {
	f := newKimiOAuthFixture(t)
	config := writeKimiConfig(t, validKimiConfig)
	f.src.connection = func() (kimiManagedConnection, error) {
		return readKimiManagedConfigAt(config, noKimiEnv, "")
	}
	if _, err := f.src.Read(fetchCtx(), "k1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte(strings.Replace(validKimiConfig, `provider = "managed:kimi-code"`, `provider = "custom"`, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	f.clock.add(oauthAutoInterval)
	credentials, hits := f.creds.Load(), f.ep.hits.Load()
	if snap, err := f.src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonUnsupported || len(snap.Windows) != 0 || snap.Credits != nil {
		t.Errorf("custom provider: %+v %v", snap, err)
	}
	if f.creds.Load() != credentials || f.ep.hits.Load() != hits {
		t.Error("an ineligible configuration read credentials or used the network")
	}
}

func TestKimiProductionUsesOnlySharedCredentialFile(t *testing.T) {
	var credentials atomic.Int32
	src := MakeKimiOAuthSource()
	restore := src.UseForTest(KimiOAuthTestHooks{
		Credentials: func(context.Context) (string, int64, error) {
			credentials.Add(1)
			return fakeKimiToken, 0, nil
		},
		Managed: func() error { return Unavailable(ReasonUnsupported) },
	})
	defer restore()
	if _, err := src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonUnsupported || credentials.Load() != 0 {
		t.Errorf("unsupported managed config: %v, reads=%d", err, credentials.Load())
	}
}
