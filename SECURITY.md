# Security Policy

## Supported versions

Security fixes go into the latest release and `main`. Older releases are not patched.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub, not in a public issue:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, how to reproduce it, and the impact you expect.

You will get an acknowledgement within 7 days. Once the issue is confirmed, a fix and a
security advisory follow, and you are credited in the advisory unless you prefer otherwise.

## Scope

Reports are especially welcome for:

- **Plan files as input.** Plans can come from other people. Business-rule formulas are
  evaluated by Pliant's own arithmetic parser, which accepts only numbers, variables,
  `+ - * /` and parentheses. Any way to make a plan execute code is in scope.
- **Prompt injection from web pages.** Page text is sent to the LLM to choose elements and
  check assertions. A page that steers Pliant into actions the plan did not ask for is in scope.
- **Secrets.** Pliant reads `ANTHROPIC_API_KEY` from the environment. Any path by which a key
  could end up in reports, screenshots or logs is in scope.

Out of scope: vulnerabilities in the websites Pliant tests, and issues in third-party
dependencies that are already reported upstream (Dependabot tracks those).
