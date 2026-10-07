// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	cases := []struct {
		name   string
		in     string
		secret string
		keep   string
	}{
		{"env assignment", "OPENAI_API_KEY=sk-test-abcdefghijklmnop1234", "sk-test-abcdefghijklmnop1234", "OPENAI_API_KEY="},
		{"export", `export GITHUB_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123456789"`, "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "GITHUB_TOKEN="},
		{"json", `{"apiKey": "AbCdEf123456", "name": "demo"}`, "AbCdEf123456", `"name": "demo"`},
		{"yaml", "db:\n  password: hunter2\n  host: localhost", "hunter2", "host: localhost"},
		{"yaml plain word password", "password: swordfish", "swordfish", "password:"},
		{"toml", `client_secret = 'zz-very-secret-value'`, "zz-very-secret-value", "client_secret = '"},
		{"passwd flag", "mysql --password=Tr0ub4dor&3 -h db", "Tr0ub4dor&3", "-h db"},
		{"credential", "AWS_CREDENTIALS=abc/def+ghi", "abc/def+ghi", "AWS_CREDENTIALS="},
		{"bearer", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' https://x", "abcdefghijklmnopqrstuvwxyz0123", "Authorization: Bearer"},
		{"basic", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA==", "Basic"},
		{"cookie", "Cookie: session=abc123def456; theme=dark", "abc123def456", "Cookie:"},
		{"pem", "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----\nafter", "MIIEowIBAAKCAQEA", "after"},
		{"pem on one line", "here -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk -----END OPENSSH PRIVATE KEY----- done", "b3BlbnNzaC1rZXk", "done"},
		{"pem cut", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", ""},
		{"anthropic", "use sk-ant-api03-abcdefghijklmnopqrstuv please", "sk-ant-api03-abcdefghijklmnopqrstuv", "please"},
		{"openai bare", "the key is sk-proj-ABCDEFGHIJKLMNOPQRSTUV", "sk-proj-ABCDEFGHIJKLMNOPQRSTUV", "the key is"},
		{"github pat", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", ""},
		{"gho", "gho_abcdefghijklmnopqrstuvwxyz0123", "gho_abcdefghijklmnopqrstuvwxyz0123", ""},
		{"slack", "xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij", ""},
		{"slack user", "xoxp-1234567890-abcdefghij", "xoxp-1234567890-abcdefghij", ""},
		{"aws", "AKIAIOSFODNN7EXAMPLE in the logs", "AKIAIOSFODNN7EXAMPLE", "in the logs"},
		{"google", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "AIzaSyA1234567890abcdefghijklmnopqrstuv", ""},
		{"jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "token"},
		{"url credentials", "git clone https://alice:s3cr3tpass@github.com/x/y.git", "s3cr3tpass", "https://alice:"},
		{"postgres url", "DATABASE_URL=postgres://app:pa55word@db:5432/app", "pa55word", "DATABASE_URL="},
		{"redis url without user", "redis://:s3cretvalue@cache:6379", "s3cretvalue", "redis://"},
		{"pass", "DB_PASS=letmein99", "letmein99", "DB_PASS="},
		{"smtp pass", "SMTP_PASS: mailpw", "mailpw", "SMTP_PASS:"},
		{"strong short number", "password=123456", "123456", "password="},
		{"strong placeholder-like", "API_PASSWORD=<x>real", "<x>real", "API_PASSWORD="},
		{"stripe", "use sk_" + "live_51HabcdefghijklmnopQRST now", "sk_" + "live_51HabcdefghijklmnopQRST", "now"},
		{"stripe restricted", "rk_" + "test_abcdefghijklmnop1234", "rk_" + "test_abcdefghijklmnop1234", ""},
		{"slack app", "xa" + "pp-1-A0123456789-abcdef", "xa" + "pp-1-A0123456789-abcdef", ""},
		{"slack webhook", "post to https://hooks.slack.com/" + "services/T000/B000/XXXXXXXX", "T000/B000/XXXXXXXX", "post to"},
		{"google oauth", "ya" + "29.a0AfH6SMBabcdefghijklmnop", "ya" + "29.a0AfH6SMBabcdefghijklmnop", ""},
		{"sendgrid", "SG" + ".abcdefghijklmnopqr.stuvwxyz0123456789ab", "SG" + ".abcdefghijklmnopqr.stuvwxyz0123456789ab", ""},
		{"digitalocean", "dop_" + "v1_0123456789abcdef0123456789abcdef0123456789abcdef", "dop_" + "v1_0123456789abcdef", ""},
		{"password flag", "psql --password Hunter22 -h db", "Hunter22", "-h db"},
		{"api key flag", "tool --api-key abc123xyz run", "abc123xyz", "run"},
		{"curl user", "curl -u admin:pw-123 https://x", "pw-123", "-u admin:"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, n := Redact(c.in)
			if strings.Contains(out, c.secret) {
				t.Fatalf("secret kept: %q", out)
			}
			if n == 0 || !strings.Contains(out, Redacted) {
				t.Fatalf("no redaction counted: %q (%d)", out, n)
			}
			if c.keep != "" && !strings.Contains(out, c.keep) {
				t.Fatalf("lost %q: %q", c.keep, out)
			}
		})
	}
}

func TestRedactKeepsNonSecrets(t *testing.T) {
	cases := []string{
		"commit 3f2a31bb4f3f81c58206f03a62fdc0b9e1d2c3a4 fixed it",
		"workspace 4c1d5a7e-9b2f-4e8a-8c3d-1f2e3a4b5c6d",
		"![logo](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==)",
		"The key: rotate it every month.",
		"max_tokens=4096 and num_tokens: 12",
		"Use the keyboard=qwerty layout",
		"PWD=/Users/me/work OLDPWD=/tmp",
		"author: Jane Doe",
		"See the primary key: id",
		"API_KEY=$OPENAI_API_KEY and TOKEN=${GH_TOKEN}",
		"api_key: <your key>",
		"Take the compass and the passenger list",
		"mkdir -p build && ls -u dir",
		"Run go test ./pkg/... then task check:ts",
		"https://github.com/DiamondForgeFr/moltenterm/pull/335",
	}
	for _, in := range cases {
		out, n := Redact(in)
		if n != 0 || out != in {
			t.Errorf("changed %q into %q (%d)", in, out, n)
		}
	}
}

func TestRedactIsIdempotent(t *testing.T) {
	in := "OPENAI_API_KEY=sk-test-abcdefghijklmnop1234 Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"
	once, n1 := Redact(in)
	twice, n2 := Redact(once)
	if once != twice || n2 != 0 || n1 != 2 {
		t.Fatalf("not idempotent: %q (%d) then %q (%d)", once, n1, twice, n2)
	}
}
