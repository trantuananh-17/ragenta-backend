# Vendored skills

These are **not ours**. They come verbatim from the public
[`better-auth/skills`](https://github.com/better-auth/skills) repository.

Do not edit them in place — a local change is silently lost the next time they are refreshed from
upstream, and it makes their provenance a lie. If Ragenta needs different guidance, write a
Ragenta skill next to them and say why it differs.

| Skill | Covers |
| --- | --- |
| `better-auth-best-practices` | Server and client setup, adapters, sessions, plugins, env |
| `better-auth-security-best-practices` | Rate limiting, secrets, CSRF, trusted origins, cookies, token encryption |
| `email-and-password-best-practices` | Verification, password reset, policies, hashing |
| `organization-best-practices` | Multi-tenancy, members, invitations, custom roles, RBAC |
| `two-factor-authentication-best-practices` | TOTP, OTP delivery, backup codes, trusted devices |
| `create-auth-skill` | Scaffolding auth into a project from scratch |

Ragenta implements none of the 2FA guidance yet — that skill is here for when it does.

Where Ragenta deliberately diverges from what these recommend, the reason is in the code:
`src/auth/auth.ts` explains why `requireLocalEmailVerified` is left at its default, and
`CLAUDE.md` explains why product endpoints stay out of Better Auth plugins.
