# Design authorities, by discipline

Who to consult on an open design question, by the discipline it belongs to (ADR-064). Find the question's discipline
first, then read and compare that row's authorities before recommending. An event-sourcing framework is consulted
on a question about events, not on one about menus.

This isn't a full list. A row is added when a question first needs it, and an authority is added when one turns out
to be the right precedent. Each row names the ADRs that have already used it.

**How to read a row:**
- **Standards and guides** define good practice. Prefer them when they speak to the question.
- **Inspirations and competitors** are products or frameworks that solved the same problem. Note each one's design
  reason and what copying it would cost us.
- **Local** is where a copy is kept, for reading offline.

| Discipline | Standards and guides | Inspirations and competitors | Local | Used in |
|---|---|---|---|---|
| **Event sourcing and DCB** (consistency, tags, projections, processors, upcasting) | [dcb.events](https://dcb.events) (the DCB specification) | Axon 5; Emmett; Marten (its async daemon) | Axon jars: `~/.m2/repository/org/axonframework`, Gary's `generator-axon5-scratch`. Emmett: `~/Projects/emmett` (`src/docs/guides`) | ADR-003, 031, 047, 048, 059, 061 |
| **Event modelling** (chapters, slices, specifications, the timeline) | Adam Dymitruk, [eventmodeling.org](https://eventmodeling.org); Martin Dilger, *Understanding Eventsourcing* | prooph board | The book: `/Volumes/SD/e-books/eventmodeling-and-eventsourcing (1).pdf` (read with PyMuPDF) | ADR-031 |
| **Domain modelling and contexts** (bounded contexts, integration between them) | Eric Evans, *Domain-Driven Design*; Vaughn Vernon, *Implementing DDD* | Axon 5 (integration events) | | ADR-059, 061 |
| **CQRS and task-based UI** (commands as intent, not edits) | Greg Young; Udi Dahan | | | ADR-065 |
| **UI navigation and information architecture** (menus, wayfinding, flows, grouping) | Nielsen Norman Group ([nngroup.com](https://www.nngroup.com)); Rosenfeld, Morville and Arango, *Information Architecture* (4th ed.); [Material Design 3: navigation](https://m3.material.io); Apple Human Interface Guidelines; [GOV.UK Design System](https://design-system.service.gov.uk) (service navigation, task list, one thing per page) | | | ADR-065 |
| **Object-based UI** (screens built around the things people work with) | Sophia Prater, Object-Oriented UX and the ORCA process (objects, relationships, calls to action, attributes) | Naked Objects (Richard Pawson; now Apache Causeway); react-admin and Refine (resources → menu and pages); Power Apps model-driven apps (site map: area → group → subarea) | | ADR-065 |
| **API design** (routes, errors, contracts) | RFC 9457 (Problem Details); OpenAPI 3.1 | | | ADR-005, 025, 029 |
| **Authentication and sessions** | NIST SP 800-63B; OWASP's authentication and session cheat sheets; OAuth 2 and OpenID Connect | Better Auth (its docs and source) | | ADR-055, 056, 057 |
| **Authorisation** | OWASP (deny by default); role-based access control (RBAC) | Cedar | | ADR-058, 060 |
| **Software supply chain and security releases** | GitHub's advisory database; OpenSSF | | | ADR-063 |
| **Payments and merchant of record** | Paddle's documentation | Braintree | | ADR-034, 036, 037 |
| **Durable work and timers** | Temporal's documentation | | | ADR-031, 033, 042 |
| **Personal data and erasure** | GDPR, and the Isle of Man's data protection law | Axon's data protection module; Marten's masking (not yet compared) | | ADR-062 |
| **Databases** | PostgreSQL's documentation and release notes; AWS RDS | | | ADR-001, 054, 063 |

**Rows to add when a question first needs them:** accessibility (WCAG 2.2), testing, deployment and operations,
observability.
