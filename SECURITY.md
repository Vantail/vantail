# Security

## Reporting something

Use GitHub's private vulnerability reporting: **[Report a
vulnerability](https://github.com/Vantail/vantail/security/advisories/new)**,
also reachable from the Security tab. It opens a thread only you and the
maintainers can read, so nothing is public while it is being worked out.

Please do not open a public issue or pull request for a suspected
vulnerability. Both are visible the moment they are filed, and for the classes
of problem below that is the disclosure itself.

## What is worth reporting

Vantail has a larger surface than its size suggests. It defines the permission
model applications rely on to sandbox filesystem and process access, and it
ships an updater that downloads a bundle and executes it. Three things matter
most, and naming them is more useful than a general invitation:

- **Reaching a path outside the configured `permissions.filesystem` scopes.**
  Including through path resolution, symlinks, or a dialog or drop grant being
  made to cover more than the path the user actually chose.
- **Running a program outside `permissions.shell.allow`.** Including through
  `shell.open`, which on every platform can be talked into "run this program"
  given the right argument.
- **Getting the updater to install a bundle whose Ed25519 signature does not
  verify.** Or to install one signed by a key other than the application's.

Anything else that lets a page reach further than the config granted is in
scope too. Those three are where to look first.

## What is not a vulnerability

An application that grants itself broad permissions in its own
`vantail.config.ts` is doing what it asked for. `permissions: { shell: { allow:
[...] } }` that allows a shell is not a sandbox escape; it is a shell, and the
developer wrote it down.

The line is the one [CONTRIBUTING.md](CONTRIBUTING.md) draws: permissions are
deny-by-default, and anything that widens what an application can reach
**without the config saying so** is a bug. A config that says so is not.

Reports about dependencies are welcome but usually already known - see
[.github/workflows/audit.yml](.github/workflows/audit.yml), which scans the
tree weekly.

## What happens next

This is a small project, so the honest answer is best effort: expect a few
days rather than a few hours, and longer if it lands over a weekend. You will
get an acknowledgement that a person has read it before you get an answer
about the fix.

Fixes go to the latest release. The runtime ships as a precompiled binary that
application developers cannot patch themselves, so a fix means a release
rather than advice, and getting one out is the priority over backporting.

You will be credited in the advisory and the changelog unless you would rather
not be. Say either way when you report; the default is to credit you.
