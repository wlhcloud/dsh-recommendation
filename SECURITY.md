# Security

Please report security issues privately through GitHub Security Advisories instead of opening a public issue.

The plugin stores a derived interest profile inside each caller-provided workspace. Applications integrating it are responsible for authenticating users, isolating workspaces, validating session ownership, and deciding what content may be sent to the configured model endpoint.

Never commit API keys, production profiles, chat logs, or user workspaces. Model inputs must be treated as untrusted data.
