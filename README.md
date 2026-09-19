# Eventmodelers Build Kits

[`eventmodelers-cli`](./eventmodelers-cli) connects an [Eventmodelers](https://eventmodelers.ai) board to an autonomous coding agent that picks up slice status changes, implements the code, and marks work done — for any of the stacks below.

```bash
npx @eventmodelers/cli init --stack node
```

Add `--demo` to install a ready-made 16-slice example model alongside the scaffold, so the agent has something to build before you connect a board of your own.

## Official stacks

| Stack key | Stack |
|-----|-------|
| `node` | Node.js / TypeScript |
| `supabase` | Supabase |
| `axon` | Axon Framework (Java/Kotlin) |
| `umadb` | UmaDB (Java) |

Not a stack, but also built in: `npx @eventmodelers/cli init-modeling` installs skills + the agent loop only, with no backend scaffold.

Previously these shipped as separate npm packages (`build-kit-node`, `build-kit-axon`, `build-kit-supabase`, `agent-modeling-kit`) with near-duplicated installer code. They're now templates inside the single `eventmodelers-cli` package — see [`eventmodelers-cli/README.md`](./eventmodelers-cli/README.md).

## Unofficial / community kits

These are not maintained in this repo and follow no guaranteed structure — link only, use at your own judgment.

| Stack | Repo | Notes |
|-------|------|-------|
| .NET | [Powerworks/K9DatingApp](https://github.com/Powerworks/K9DatingApp/) | Community reference for event modeling in .NET; not adapted to the build-kit skill/installer pattern used by the official kits above. |
| .NET / C# | [Cratis/Eventmodelers-Build-Kit-CSharp](https://github.com/Cratis/Eventmodelers-Build-Kit-CSharp) | Maintained by the Cratis team. Builds board slices as Cratis (Arc + Chronicle) vertical slices in a .NET/C# project; `dotnet build` / `dotnet test` as the check. Install: `npx @eventmodelers/cli init --stack cratis-csharp --git https://github.com/Cratis/Eventmodelers-Build-Kit-CSharp`. |
| Java | [Cratis/Eventmodelers-Build-Kit-Java](https://github.com/Cratis/Eventmodelers-Build-Kit-Java) | Maintained by the Cratis team. Builds board slices as Cratis (Chronicle) vertical slices in a Java project; `./gradlew build` / `./gradlew test` as the check. Install: `npx @eventmodelers/cli init --stack cratis-java --git https://github.com/Cratis/Eventmodelers-Build-Kit-Java`. |
| Kotlin | [Cratis/Eventmodelers-Build-Kit-Kotlin](https://github.com/Cratis/Eventmodelers-Build-Kit-Kotlin) | Maintained by the Cratis team. Builds board slices as Cratis (Arc + Chronicle) vertical slices in a Kotlin project; `./gradlew build` / `./gradlew test` as the check. Install: `npx @eventmodelers/cli init --stack cratis-kotlin --git https://github.com/Cratis/Eventmodelers-Build-Kit-Kotlin`. |
| Rust | [gklijs/skilj-build-kit](https://github.com/gklijs/skilj-build-kit) | Built on [skilj](https://github.com/gklijs/skilj), the author's own Postgres-backed event-sourcing library using DCB (Dynamic Consistency Boundary) instead of classic aggregates. Follows the build-kit skill/installer pattern (four Claude Code skills for the usual slice shapes) — same approach as the official kits. Install: `npx @eventmodelers/cli init --stack skilj --git https://github.com/gklijs/skilj-build-kit`. |
