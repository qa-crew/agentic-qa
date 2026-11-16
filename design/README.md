# Design

The dashboard's look, for designers and other tools. The source of truth is the dashboard's
[`theme.css`](../.claude/skills/qa-dashboard/dashboard/theme.css): change a colour there, then run `npm run build`.

## Tokens

`tokens/<theme>.<mode>.tokens.json` holds one theme in one mode, in the
[Design Tokens (DTCG)](https://www.designtokens.org/) format. There are four themes, each in light and dark:

| Theme | What it's for |
|---|---|
| **Geist** (the default) | Black and white, with blue for "your turn" |
| **Carbon** | IBM Plex, square corners, and a shape for every status |
| **Industrial** | Black chrome and safety yellow |
| **Corporate** | Navy, with serif headings |

`scripts/build.mjs` writes these files; `npm run check` fails when they don't match `theme.css`. Don't edit them by
hand.

**In Figma:** create a variable collection with eight modes (for example "Geist light"), and import each file into
its mode. Every file has the same token names, so the modes line up.

## Colour rules

- **The accent means "your turn"** (Waiting for you, Your turn: review) and marks primary buttons. Nothing else uses it.
- **Green, orange and red are only for test status:** passed, warning or flaky, failed.
- **Everything else is neutral.** Running, Next, Updated and New are ink or grey, not colour.
- **Chart series are locked:** series 1 to 5 keep their colours everywhere.
- **Contrast:** text is at least 4.5:1 against its background, and other marks at least 3:1. Industrial's yellow is
  only used with black text, and gets an ink edge where it's a mark on a light page.

## Type

| Theme | Body | Headings | Code |
|---|---|---|---|
| Geist | Geist | Geist, 600 | Geist Mono |
| Carbon | IBM Plex Sans | IBM Plex Sans, 600 | IBM Plex Mono |
| Industrial | Barlow | Barlow Condensed, 700 | IBM Plex Mono |
| Corporate | Source Sans 3 | Source Serif 4, 600 | Source Code Pro |

The fonts and their licences (SIL OFL) are in the dashboard's `fonts/` folder.
