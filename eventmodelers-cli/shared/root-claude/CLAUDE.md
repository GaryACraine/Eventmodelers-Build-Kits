# Project Configuration

This project can have more than one eventmodelers agent kit installed at once — typically
one backend stack plus the modeling kit, working side by side on the same board. Each
installed kit ships its own CLAUDE.md with that kit's own responsibilities. Check which
of these exist in this project and read whichever are present, following all of them
together:

- `.build-kit/CLAUDE.md` — building this project's backend from board slices
- `.agent-modeling-kit/CLAUDE.md` — designing and updating the event model board itself

Neither is guaranteed to exist — this file is installed once, up front, before either kit
is known to be present.

`.agent-modeling-kit/CLAUDE-STANDALONE.md` is deliberately *not* in that list: it holds the
rules for the self-directed turns a `run --standalone` session gets, and the agent in such a
session reads it itself when the first one arrives. Leave it alone otherwise — it licenses
work nobody asked for, which is right for those turns and wrong everywhere else.