tags: [error-fixture]
timestamp: 2026-08-30T00:00:00Z
---

# Error fixture

This file deliberately has no opening `---` frontmatter delimiter (the
line above is inert body text to `okf-kit`, not a real frontmatter
block), so `okf-kit`'s `frontmatter-required` rule reports a real
`severity: "error"` finding ("Missing frontmatter block..."), counted in
`.summary.errors`. See `scripts/fixtures/okf-selectors/README.md` for why
this bundle exists (it exercises the `errors`-leg of the guard's blocking
condition, which `clean-report.json` and `drifted-report.json` both leave
at 0). No citations here, so `citations-resolve` stays silent.
