# Recorded runs

Each file is one run, kept as it happened: `<date>-<name>.log`, with the date, the commit, the command and its exit
code at the top. Record one with `npm run security:record -- <name> -- <command…>` (see [../README.md](../README.md)),
and link it from [../EVIDENCE.md](../EVIDENCE.md)'s "Last run". No run is replaced: the same name again on the same
day is `<date>-<name>-2.log`, then `-3`, so a failed run stays beside the one that passed after it.
