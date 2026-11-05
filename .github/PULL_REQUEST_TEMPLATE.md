## What does this change?

<!-- One paragraph. What is different after this PR, compared with main? -->

## Why is it needed?

<!-- The problem being solved. Link the issue with "Closes #123" if there is one. -->

## Type of change

- [ ] Bug fix (behaviour corrected, output unchanged or corrected)
- [ ] Behaviour change (what the server does is different)
- [ ] Refactor / internal only (output stays byte-identical)
- [ ] Documentation only
- [ ] CI / repository configuration only
- [ ] Dependency update

## Is anything user-visible affected?

Tick everything that applies. Anything ticked here also has to be reflected in the
public documentation, and a reviewer will ask about it.

- [ ] Tool name, description, arguments, or return shape
- [ ] Default configuration value
- [ ] Files written to disk (location, name, format, retention)
- [ ] Nothing user-visible

## Checklist

- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run check:docs` passes (required if any `.md` file changed)
- [ ] Output-affecting changes are covered by a test asserting the **exact** output, not a substring
- [ ] No telemetry, analytics, or outbound network calls added
- [ ] No credentials, tokens, customer data, or production prompt content included
- [ ] No personal paths (`C:\Users\...`, `/home/...`) or personal contact details in code, tests, comments or docs
- [ ] No version bump or tag in this PR (releases are cut separately)

## Notes for the reviewer

<!-- Trade-offs, alternatives rejected, anything you are unsure about. -->
