import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, RedactError } from "../../src/utils/redact.js";

describe("redact", () => {
  describe("redactSecrets()", () => {
    describe("AWS access keys", () => {
      it("redacts AWS access key IDs (AKIA + 16 uppercase alphanumeric)", () => {
        // Pattern: AKIA followed by exactly 16 characters of [0-9A-Z]
        const input = "My AWS key is AKIA1111111111111111";
        const result = redactSecrets(input);
        assert.equal(result, "My AWS key is [REDACTED]");
      });

      it("redacts multiple AWS keys in the same string", () => {
        const input =
          "AKIA2222222222222222 and another AKIA3333333333333333";
        const result = redactSecrets(input);
        assert.equal(result, "[REDACTED] and another [REDACTED]");
      });

      it("does not redact AWS key with lowercase letters (only uppercase allowed)", () => {
        const input = "AKIA12345678901abc is not redacted";
        const result = redactSecrets(input);
        // Pattern requires [0-9A-Z] only, lowercase fails
        assert.equal(result, input);
      });

      it("does not redact incomplete AWS key format", () => {
        const input = "AKIA12345 (too short)";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });
    });

    describe("GitHub tokens", () => {
      it("redacts ghp_ tokens (36+ chars)", () => {
        const input = "GitHub token: ghp_1234567890123456789012345678901234567890";
        const result = redactSecrets(input);
        assert.equal(result, "GitHub token: [REDACTED]");
      });

      it("redacts gho_ tokens (OAuth)", () => {
        const input = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
        const result = redactSecrets(input);
        assert.equal(result, "[REDACTED]");
      });

      it("redacts ghs_ tokens (server-to-server)", () => {
        const input = "Server token: ghs_0123456789abcdefghijklmnopqrstuvwxyz";
        const result = redactSecrets(input);
        assert.equal(result, "Server token: [REDACTED]");
      });

      it("does not redact GitHub token prefix with fewer than 36 chars", () => {
        const input = "ghp_short";
        const result = redactSecrets(input);
        assert.equal(result, "ghp_short");
      });

      it("redacts multiple GitHub tokens", () => {
        const input =
          "ghp_abcdefghijklmnopqrstuvwxyz0123456789 and gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const result = redactSecrets(input);
        assert.equal(result, "[REDACTED] and [REDACTED]");
      });
    });

    describe("Slack tokens", () => {
      it("redacts xoxb- tokens (bot)", () => {
        const input = "Slack bot token: xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt";
        const result = redactSecrets(input);
        assert.equal(result, "Slack bot token: [REDACTED]");
      });

      it("redacts xoxp- tokens (user)", () => {
        const input = "xoxp-user-token-123456";
        const result = redactSecrets(input);
        assert.equal(result, "[REDACTED]");
      });

      it("redacts xoxr- tokens (refresh)", () => {
        const input = "xoxr-refresh-token-abcdef";
        const result = redactSecrets(input);
        assert.equal(result, "[REDACTED]");
      });

      it("redacts xoxa- tokens (app)", () => {
        const input = "xoxa-app-token-12345678";
        const result = redactSecrets(input);
        assert.equal(result, "[REDACTED]");
      });

      it("redacts xoxs- tokens (socket mode)", () => {
        const input = "xoxs-socket-token-xyz789";
        const result = redactSecrets(input);
        assert.equal(result, "[REDACTED]");
      });

      it("redacts multiple Slack tokens", () => {
        const input =
          "xoxb-bot and xoxp-user are both here";
        const result = redactSecrets(input);
        assert.equal(result, "[REDACTED] and [REDACTED] are both here");
      });
    });

    describe("Bearer tokens", () => {
      it("redacts Bearer tokens in headers", () => {
        const input = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
        const result = redactSecrets(input);
        assert.equal(result, "Bearer [REDACTED]");
      });

      it("preserves Bearer prefix when redacting", () => {
        const input = "Bearer abc123def456";
        const result = redactSecrets(input);
        assert.equal(result, "Bearer [REDACTED]");
      });

      it("handles Bearer tokens with special characters", () => {
        const input = "Bearer abc-123_456.789~+/xyz=";
        const result = redactSecrets(input);
        assert.equal(result, "Bearer [REDACTED]");
      });

      it("handles multiple Bearer tokens", () => {
        const input = "Bearer token1 and Bearer token2";
        const result = redactSecrets(input);
        assert.equal(result, "Bearer [REDACTED] and Bearer [REDACTED]");
      });

      it("preserves whitespace variations with Bearer", () => {
        const input = "Bearer  token_with_extra_space";
        const result = redactSecrets(input);
        assert.equal(result, "Bearer  [REDACTED]");
      });
    });

    describe("Credentials in URLs", () => {
      it("redacts credentials in URLs (scheme://user:password@host)", () => {
        const input = "Database URL: postgres://admin:mysecretpassword@localhost:5432/db";
        const result = redactSecrets(input);
        assert.equal(
          result,
          "Database URL: postgres://admin:[REDACTED]@localhost:5432/db"
        );
      });

      it("redacts HTTP credentials", () => {
        const input = "http://user:password@example.com/api";
        const result = redactSecrets(input);
        assert.equal(result, "http://user:[REDACTED]@example.com/api");
      });

      it("redacts HTTPS credentials", () => {
        const input = "https://user:password@api.example.com";
        const result = redactSecrets(input);
        assert.equal(result, "https://user:[REDACTED]@api.example.com");
      });

      it("handles complex passwords with special characters", () => {
        const input = "mongodb://user:mypassword123@mongo.example.com";
        const result = redactSecrets(input);
        assert.equal(result, "mongodb://user:[REDACTED]@mongo.example.com");
      });

      it("redacts multiple credential URLs", () => {
        const input =
          "postgres://admin:pass1@host1 and mysql://root:pass2@host2";
        const result = redactSecrets(input);
        assert.equal(
          result,
          "postgres://admin:[REDACTED]@host1 and mysql://root:[REDACTED]@host2"
        );
      });

      it("preserves URLs without credentials", () => {
        const input = "https://example.com/path?query=value";
        const result = redactSecrets(input);
        assert.equal(result, "https://example.com/path?query=value");
      });
    });

    describe("Generic key=value patterns", () => {
      it("redacts api_key=value", () => {
        const input = "api_key=sk-abc123def456";
        const result = redactSecrets(input);
        assert.equal(result, "api_key=[REDACTED]");
      });

      it("redacts apiKey: value (with colon)", () => {
        const input = "apiKey: sk_1234567890";
        const result = redactSecrets(input);
        assert.equal(result, "apiKey: [REDACTED]");
      });

      it("redacts api-key=value (with dash)", () => {
        const input = "api-key=mytoken123";
        const result = redactSecrets(input);
        assert.equal(result, "api-key=[REDACTED]");
      });

      it("redacts secret=value", () => {
        const input = "secret=my_secret_value";
        const result = redactSecrets(input);
        assert.equal(result, "secret=[REDACTED]");
      });

      it("redacts password=value", () => {
        const input = "password=SuperSecure123!";
        const result = redactSecrets(input);
        assert.equal(result, "password=[REDACTED]");
      });

      it("redacts passwd=value", () => {
        const input = "passwd=oldpassword";
        const result = redactSecrets(input);
        assert.equal(result, "passwd=[REDACTED]");
      });

      it("redacts token=value", () => {
        const input = "token=abc123xyz789";
        const result = redactSecrets(input);
        assert.equal(result, "token=[REDACTED]");
      });

      it("redacts authorization=value", () => {
        const input = "authorization=token123";
        const result = redactSecrets(input);
        assert.equal(result, "authorization=[REDACTED]");
      });

      it("handles quoted values", () => {
        const input = 'api_key="secret123"';
        const result = redactSecrets(input);
        assert.equal(result, 'api_key="[REDACTED]"');
      });

      it("handles single quoted values", () => {
        const input = "password='mypassword'";
        const result = redactSecrets(input);
        assert.equal(result, "password='[REDACTED]'");
      });

      it("is case-insensitive for key names", () => {
        const input = "API_KEY=test API_Key=test2 ApiKey=test3";
        const result = redactSecrets(input);
        assert.equal(result, "API_KEY=[REDACTED] API_Key=[REDACTED] ApiKey=[REDACTED]");
      });

      it("handles multiple key=value pairs", () => {
        const input =
          "api_key=key1 secret=sec1 password=pass1";
        const result = redactSecrets(input);
        assert.equal(
          result,
          "api_key=[REDACTED] secret=[REDACTED] password=[REDACTED]"
        );
      });

      it("preserves non-secret key=value pairs", () => {
        const input = "username=john email=john@example.com";
        const result = redactSecrets(input);
        assert.equal(result, "username=john email=john@example.com");
      });

      it("handles whitespace around delimiters", () => {
        const input = "api_key  :  secretvalue";
        const result = redactSecrets(input);
        assert.equal(result, "api_key  :  [REDACTED]");
      });
    });

    describe("Long hex strings", () => {
      it("redacts hex strings with 64+ characters", () => {
        const hex64 =
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const input = `Hex key: ${hex64}`;
        const result = redactSecrets(input);
        assert.equal(result, "Hex key: [REDACTED]");
      });

      it("does not redact hex strings with fewer than 64 characters", () => {
        const hex63 =
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde";
        const input = `Short hex: ${hex63}`;
        const result = redactSecrets(input);
        assert.equal(result, `Short hex: ${hex63}`);
      });

      it("redacts hex strings in quotes", () => {
        const hex64 =
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const input = `"${hex64}"`;
        const result = redactSecrets(input);
        assert.equal(result, '"[REDACTED]"');
      });

      it("redacts hex strings after equals", () => {
        const hex64 =
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const input = `key=${hex64}`;
        const result = redactSecrets(input);
        assert.equal(result, "key=[REDACTED]");
      });

      it("redacts hex strings in JSON", () => {
        const hex64 =
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const input = `{"hash": "${hex64}"}`;
        const result = redactSecrets(input);
        assert.equal(result, '{"hash": "[REDACTED]"}');
      });

      it("redacts multiple long hex strings", () => {
        const hex64a =
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const hex64b =
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        const input = `First: ${hex64a} Second: ${hex64b}`;
        const result = redactSecrets(input);
        assert.equal(result, "First: [REDACTED] Second: [REDACTED]");
      });

      it("handles very long hex strings", () => {
        const hex128 =
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const input = `Secret: ${hex128}`;
        const result = redactSecrets(input);
        assert.equal(result, "Secret: [REDACTED]");
      });

      it("is case-insensitive for hex", () => {
        const hexLower =
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const hexUpper =
          "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
        const input = `Lower: ${hexLower} Upper: ${hexUpper}`;
        const result = redactSecrets(input);
        assert.equal(result, "Lower: [REDACTED] Upper: [REDACTED]");
      });
    });

    describe("Multiple secrets in one string", () => {
      it("redacts multiple different secret types", () => {
        const input =
          "AWS: AKIAIOSFODNN7EXAMPLE GitHub: ghp_abcdefghijklmnopqrstuvwxyz0123456789 " +
          "Secret: xoxb-12345 password=secret123";
        const result = redactSecrets(input);
        assert.match(result, /AWS: \[REDACTED\]/);
        assert.match(result, /GitHub: \[REDACTED\]/);
        assert.match(result, /Secret: \[REDACTED\]/);
        assert.match(result, /password=\[REDACTED\]/);
      });

      it("redacts secrets in complex configuration", () => {
        const input =
          "db_url: postgres://user:password@localhost " +
          "api_key: sk-1234567890 " +
          "token: xoxp-123456";
        const result = redactSecrets(input);
        assert.match(result, /db_url: postgres:\/\/user:\[REDACTED\]@localhost/);
        assert.match(result, /api_key: \[REDACTED\]/);
        assert.match(result, /token: \[REDACTED\]/);
      });

      it("redacts secrets in code-like context", () => {
        const input =
          'const credentials = { apiKey: "sk-abc123", ' +
          'password: "secret456", token: xoxb-token789 };';
        const result = redactSecrets(input);
        assert.equal(
          result,
          'const credentials = { apiKey: "[REDACTED]", ' +
            'password: "[REDACTED]", token: [REDACTED] };'
        );
      });
    });

    describe("Edge cases and non-secret content", () => {
      it("returns empty string unchanged", () => {
        const result = redactSecrets("");
        assert.equal(result, "");
      });

      it("preserves non-secret strings", () => {
        const input = "This is a normal string with no secrets";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("preserves whitespace and formatting", () => {
        const input = "Line 1\nLine 2\n  indented line";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("preserves URLs without credentials", () => {
        const input = "Visit https://example.com for more info";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("preserves normal API references", () => {
        const input = "Call the API endpoint at GET /api/users";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("preserves hex strings shorter than 64 chars", () => {
        const input = "SHA256: 0123456789abcdef0123456789abcdef";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("preserves partial pattern matches", () => {
        const input = "AKIA is an AWS prefix but AKIA12 is not a real key";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("handles strings with special characters", () => {
        const input = "Special chars: !@#$%^&*()_+-=[]{}|;:',.<>?/";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("preserves JSON structure with no secrets", () => {
        const input = '{"user": "john", "email": "john@example.com"}';
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("handles newlines and multiple spaces", () => {
        const input =
          "Key:   value\n" +
          "Another: line\n" +
          "  Indented: data";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("is idempotent (redacting already redacted text has no effect)", () => {
        const input = "Secret: [REDACTED]";
        const result = redactSecrets(input);
        assert.equal(result, input);
      });

      it("handles very long strings without secrets", () => {
        const longString = "a".repeat(10000);
        const result = redactSecrets(longString);
        assert.equal(result, longString);
      });
    });

    describe("Real-world scenarios", () => {
      it("redacts secrets in environment variable dump", () => {
        const input =
          "DATABASE_URL=postgres://admin:password123@db.example.com\n" +
          "API_KEY=sk-abc123def456\n" +
          "SLACK_TOKEN=xoxb-123456789012\n" +
          "JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const result = redactSecrets(input);
        assert.match(result, /DATABASE_URL=postgres:\/\/admin:\[REDACTED\]@db\.example\.com/);
        assert.match(result, /API_KEY=\[REDACTED\]/);
        assert.match(result, /SLACK_TOKEN=\[REDACTED\]/);
        assert.match(result, /JWT_SECRET=\[REDACTED\]/);
      });

      it("redacts secrets in error logs", () => {
        const input =
          "ERROR: Failed to authenticate. Token: xoxb-token123. " +
          "User: admin@example.com.";
        const result = redactSecrets(input);
        assert.match(result, /Token: \[REDACTED\]/);
      });

      it("redacts secrets in Python code", () => {
        const input =
          "client = boto3.client('s3', aws_access_key_id='AKIA5555555555555555', " +
          "secret='mysecretvalue')";
        const result = redactSecrets(input);
        assert.match(result, /aws_access_key_id='\[REDACTED\]'/);
        assert.match(result, /secret='\[REDACTED\]'/);
      });

      it("redacts secrets in curl commands", () => {
        const input =
          "curl -H 'Authorization: token_abc123' " +
          "https://api.example.com/endpoint";
        const result = redactSecrets(input);
        assert.match(result, /Authorization: \[REDACTED\]/);
      });

      it("redacts secrets in JSON configuration", () => {
        const input =
          '{\n' +
          '  "database": {\n' +
          '    "url": "mysql://root:secretpassword123@localhost:3306/mydb"\n' +
          '  },\n' +
          '  "api": {\n' +
          '    "token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789abc"\n' +
          '  }\n' +
          '}';
        const result = redactSecrets(input);
        assert.match(result, /url": "mysql:\/\/root:\[REDACTED\]@localhost:3306\/mydb"/);
        assert.match(result, /token": "\[REDACTED\]"/);
      });
    });
  });

  describe("RedactError", () => {
    it("is an instance of Error", () => {
      const error = new RedactError("Test error", "TEST_CODE");
      assert.ok(error instanceof Error);
    });

    it("has correct properties", () => {
      const error = new RedactError("Test message", "TEST_CODE");
      assert.equal(error.name, "RedactError");
      assert.equal(error.message, "Test message");
      assert.equal(error.code, "TEST_CODE");
      assert.equal(error.component, "redact");
    });
  });
});
