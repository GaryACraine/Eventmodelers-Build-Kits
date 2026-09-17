---
name: attributes
description: Add a new attribute or rename an existing attribute across a chain of elements from a source cell to a target cell, following inbound dependencies
---

# Attributes

> **Before doing anything else**, invoke the `connect` skill — if not already connected — to resolve `TOKEN`, `BOARD_ID`, and `BASE_URL`. Do not proceed until the connect skill has completed.

Prefer `mcp__eventmodelers__*` tools when available (registered by the `connect` skill) — the curl blocks below are the fallback for sessions without MCP connected.

You are propagating an attribute change (add or rename) across a chain of elements on an eventmodelers board. You start at the target cell, apply the change, then walk backwards through inbound dependencies until you reach the source cell, applying the change to every element along the way.

---

## Step 1 — Gather inputs

Ask the user for all required information **in a single message** (do not ask one at a time):

1. **Target cell** — the end of the chain (e.g. `B2`)
2. **Source cell** — the start of the chain (e.g. `A2`)
3. **Operation** — `add` a new attribute, or `rename` an existing one
4. If **rename**: which attribute name to rename FROM, and what to rename it TO
5. If **add**: the name of the new attribute to add

If any of these were already provided in `$ARGUMENTS`, skip asking for them.

---

## Step 2 — Resolve the chain

**Prefer MCP:** `get_attribute_chain` resolves every node between the source and target cells (inclusive), ordered target→source, each with its full `fields[]` — this collapses the manual cell-resolution and inbound-edge walk below into one call. You still need `TIMELINE_ID` (the chapter to search): if multiple chapters exist on the board, resolve which one first (see 2a fallback below, or `mcp__eventmodelers__get_nodes { "boardId": "$BOARD_ID", "type": "CHAPTER" }`) and ask the user if ambiguous.

```
mcp__eventmodelers__get_attribute_chain {
  "boardId": "$BOARD_ID",
  "timelineId": "$CHAPTER_ID",
  "targetCellName": "<target cell, e.g. B2>",
  "sourceCellName": "<source cell, e.g. A2>"
}
```

The result gives you the ordered chain directly — save it as the chain used in Step 4, and skip the manual walk in 2a–3c below. Continue with the fallback only if MCP isn't connected.

### Fallback (no MCP) — resolve both cells to nodes

For each cell (target and source), resolve it to a node using the exact same cell-resolution steps as the `examples` skill's "2c — Cell name" section (fetch chapters, fetch the chapter fresh to decode the grid, decode the cell name into a `CELL_ID`, then always fetch the cell live — `get_nodes` has no `cellId` filter) — see there for the full mechanics, substituting `x-user-id: attributes-skill`.

Take the first non-CHAPTER result as the node for each cell. Save as `TARGET_NODE` and `SOURCE_NODE`.

---

### Fallback (no MCP) — build the dependency chain

Walk backwards from `TARGET_NODE` to `SOURCE_NODE` by following inbound edges. Build an ordered list: `[TARGET_NODE, …intermediate nodes…, SOURCE_NODE]`.

### 3a — Use node edges
Each node may have an `edges` array:
```json
edges: [{ id, source, target, sourceHandle, targetHandle }]
```
An **inbound** edge is one where `edge.target === currentNode.id`.

Resolve the whole walk from **one** chapter-scoped read rather than a `get_node` per hop — `get_board_outline { "boardId": "$BOARD_ID", "chapterId": "$TIMELINE_ID" }` returns every node in the chapter (`{id, type, title, lane}` per column) *plus* a flat edge list, which is exactly what the traversal needs. Index it in memory and walk it locally; you only need the per-node `meta.fields` (Step 4), which one `get_nodes { "boardId": "$BOARD_ID", "chapterId": "$TIMELINE_ID" }` returns for the whole chapter in a single call.

Reach for a single-node fetch only for a node genuinely outside that chapter:
```
mcp__eventmodelers__get_node { "boardId": "$BOARD_ID", "nodeId": "$EDGE_SOURCE_ID", "projection": "edges" }
```

**Fallback (no MCP):** see `references/api-fallback.md` — "3a — Use Node Edges".

### 3b — Column-based fallback (if no edges)
Hand-built or imported chapters frequently have **no edges at all** — every node comes back with `edges: []` and `get_board_outline`'s edge list is empty. That is not an error and not a reason to stop: in that case grid geometry *is* the chain. Use the chapter cell layout (already in memory from 3a) to find inbound neighbours:

In a standard event modeling layout:
- **READMODEL** in the interaction row → its inbound EVENT is in the swimlane row of the **same column**
- **EVENT** in the swimlane row → its inbound COMMAND is in the interaction row of the **same column**
- **COMMAND** in the interaction row → its inbound READMODEL is in the swimlane row of the **previous column**

Resolve candidates from the chapter read you already have — do **not** issue a `?cellId=` lookup per candidate. If the chapter's `meta.timelineData.cells` is sparse or absent, derive each node's (column, row) from `node.position.x/y` bucketed against `meta.timelineData.columns[].width` and `rows[].height`; that mapping is enough to apply the three rules above. Skip candidates that don't exist or are already in the chain.

### 3c — Stop condition
Stop traversal when:
- You reach `SOURCE_NODE` (id match), OR
- There are no more inbound nodes to follow, OR
- You have visited 20 nodes (safety limit — warn the user if hit)

---

## Step 4 — Apply the change to the whole chain in one write

Compute the updated `fields` array for **every** node in the chain first, in order (TARGET_NODE first, then backwards to SOURCE_NODE), then submit them all in a **single** `submit_node_events` call. Do not write one node, check it, and move to the next — the chain is one logical edit and `events[]` takes the whole batch.

For each node, compute (don't write yet):

### If operation is `add`:
- Check if a field with that name already exists in `meta.fields` — if so, skip this node (log it).
- Otherwise append a new field:
```json
{
  "name": "<attributeName>",
  "type": "String",
  "query": false,
  "optional": false,
  "generated": false,
  "subfields": [],
  "cardinality": "Single",
  "idAttribute": false,
  "showAttributes": false,
  "technicalAttribute": false
}
```

### If operation is `rename`:
- Find the field where `name === oldName` (case-insensitive). If not found in this node, skip it (log it).
- Update only the `name` property to `newName`. Leave all other field properties unchanged.

Collect one `node:changed` event per affected node, then send them together.

**Prefer MCP** — one call for the entire chain, one event per node in `events[]`:
```
mcp__eventmodelers__submit_node_events {
  "boardId": "$BOARD_ID",
  "compact": true,
  "events": [
    {
      "id": "<uuid>",
      "eventType": "node:changed",
      "nodeId": "<NODE_ID_1>",
      "boardId": "$BOARD_ID",
      "timestamp": <epoch-ms>,
      "changedAttributes": ["meta.fields"],
      "meta": { "fields": "<updated_fields_array_1>" }
    },
    { "…one more event per remaining node in the chain…" }
  ]
}
```

Nodes that are skipped (field already exists / field not found) simply contribute no event — don't send a no-op change for them.

**Fallback (no MCP):** see `references/api-fallback.md` — "Step 4 — Apply the Change to Each Node in the Chain". The REST endpoint takes the same `NodeChangeEvent[]` body, so it batches identically — one POST, not one per node.

Verify the response is HTTP 200. If the batch fails, report the error and stop; nothing was partially applied from your side, so re-run after fixing the cause rather than retrying node by node.

If you also need to verify the result, re-read the whole chain in one call — `get_nodes { "boardId": "$BOARD_ID", "nodeIds": [<every node id you just wrote>] }` — never one `get_node` per node.

---

## Step 5 — Report back

Tell the user:

- **Operation**: add `"<name>"` / rename `"<old>"` → `"<new>"`
- **Chain**: list each element in order (type + title + cell)
- **Updated**: which nodes were changed
- **Skipped**: which nodes were skipped and why (field already exists / field not found)

Example output:
```
Operation: rename "customerId" → "clientId"

Chain traversed (target → source):
  READMODEL "Customer Overview"   (B2) ✓ renamed
  EVENT     "Customer Registered" (A3) ✓ renamed
  COMMAND   "Register Customer"   (A2) — skipped (field not found)

Done.
```
