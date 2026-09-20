# Security policy

Please do not put API keys, OAuth tokens, cookies, Session files, or other
private data in issues, pull requests, logs, or test fixtures.

MyHarness can execute shell commands and modify the current workspace when a
configured model or user invokes those tools. Project settings, extensions,
skills and prompt files are trust-sensitive inputs. Code Intelligence modules
are optional Windows artifacts and are accepted only when their published
manifest supplies exact size and SHA-256 values; the source checkout does not
contain the large runtime.

For a vulnerability that may expose private data or affect users, use the
repository's private security-advisory reporting flow when it is available:
<https://github.com/h3327725338-star/MyHarness>. Do not publish exploit details
in a public issue before maintainers have had a chance to respond. If private
reporting is unavailable, report only a minimal, non-sensitive description and
ask maintainers for a private channel.

Security reports should include the affected version or commit, operating
system, a minimal reproduction, and the impact. Redact credentials and
personal paths from all attachments. Do not attach `data/`, `.myharness/agent/`,
`auth.json`, Session/Conversation files, runtime traces or downloaded language
server archives unless a maintainer explicitly requests a safely redacted
sample.
