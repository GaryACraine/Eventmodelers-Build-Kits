---
name: init-style-guide
description: Interview the user for CSS, design tokens, brand documents, or any existing style guide material, and persist it as references inside the learn-styleguide skill so the UI the loop builds in web/ (and the board's wireframes) stay on-brand
---

# Init Style Guide

Run this whenever the user wants to give this project a design system to follow — "here's our
style guide", "add our brand CSS", "use this doc for the UI" — or wants to add more material to
one already started. This skill collects and files material. It changes the design system itself only in Step 4, and
only when the user asks.

The project's design system is `web/src/styles/design-system.css`: the tokens (colors, radius,
font) and the `mock-*` classes the model's mockups use. `npm run design-system` (in `web/`)
compiles it into `snippets/design-system.html`, the snippet every wireframe on prooph board
imports. So one file styles both the app and the board.

## Step 1 — Ask what they have

Ask the user what they'd like to provide. Accept any of:
- An existing CSS/SCSS file (a path) — design tokens, a component library stylesheet, a Tailwind
  config, etc.
- A brand/style guide document (Markdown, PDF, plain text, a Figma export, ...) — a path.
- Pasted text/tokens directly in the conversation (e.g. a color palette, font stack, spacing
  scale).
- A URL to a live, publicly reachable style guide page — only if the user gives the URL
  themselves; never search for or guess one.

If they have nothing to add right now, stop — do not create empty placeholder files.

## Step 2 — Persist each item as a reference, verbatim

For every item provided, write it into `.claude/skills/learn-styleguide/references/`. **Never
summarize, rewrite, or supplement** what was given — this is a store of source material, not an
interpretation of it.

- **A file path** → copy the file as-is into `references/<original-filename>`, preserving its
  extension (`.css`, `.scss`, `.md`, `.pdf`, ...).
- **A URL** → fetch it and save the raw content into `references/<slugified-title-or-host>.md`,
  with a one-line header noting the source URL and the fetch date.
- **Pasted text/tokens** → write into `references/<short-slug>.md`, wrapped in a fenced code block
  when it's CSS/code, with a one-line header noting what it is and the date provided.

Pick filenames that describe the content (`brand-colors.css`, `component-library.md`,
`voice-and-tone.pdf`), never generic names like `input1`.

If `references/` already has files from a previous run, list them back to the user first so they
know what's already covered, then only add what's new. Never delete or overwrite an existing
reference unless the user confirms that specific file should be replaced.

## Step 3 — Refresh learn-styleguide's index

In `.claude/skills/learn-styleguide/SKILL.md`, replace the `## References` section's contents with
one bullet per file now in `references/` — filename plus a short (one-line) description of what it
contains, based on a quick read of the file, never invented. Leave everything else in that file
(frontmatter, the "How to use this skill" section) untouched.

## Step 4 — Apply to the design system (only if asked)

If the user wants the material applied, not just filed ("use these colors"), change only the
token values in `:root` of `web/src/styles/design-system.css` to the values they gave, and tell
them which tokens changed. Don't restructure the file or invent values they didn't give. Then:

```bash
cd web && npm run design-system   # rewrites snippets/design-system.html
emcli sync push                   # restyles every wireframe on the board
```

Say that this replaces the snippet, including a hand-picked `emcli snippet add --starter` look.

## Step 5 — Confirm

Tell the user what was saved and where, e.g.:
```
Saved to .claude/skills/learn-styleguide/references/:
  - brand-colors.css     (CSS custom properties: primary/secondary palette, spacing scale)
  - voice-and-tone.md    (brand document — tone, terminology to avoid)
```
