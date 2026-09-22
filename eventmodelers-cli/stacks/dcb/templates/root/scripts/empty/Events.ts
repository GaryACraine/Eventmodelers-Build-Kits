import { Tags, Event, TaggedEvent } from "@dcb-es/event-store"

// Enrollment context events — one type + factory per event, appended by state-change slices.
// Never rewrite existing entries.

export type { Tags, Event, TaggedEvent }
