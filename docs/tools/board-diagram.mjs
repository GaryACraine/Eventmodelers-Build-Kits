#!/usr/bin/env node
// Render one chapter of an emcli workspace.json as an SVG board diagram:
// lanes as rows, slices as columns (timeline left → right), one sticky per element,
// colored by type. Copies (element.copyOf) get a dashed outline and a "copy" tag;
// each slice header shows its status.
//
//   node docs/tools/board-diagram.mjs <workspace.json> "<chapter name>" <out.svg> [--title "..."]

import fs from 'node:fs'

const [, , wsPath, chapterName, outPath, ...rest] = process.argv
if (!wsPath || !chapterName || !outPath) {
  console.error('usage: board-diagram.mjs <workspace.json> "<chapter name>" <out.svg> [--title "..."]')
  process.exit(1)
}
const titleIdx = rest.indexOf('--title')
const title = titleIdx >= 0 ? rest[titleIdx + 1] : chapterName

const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'))
const chapter = ws.chapters.find((c) => c.name === chapterName)
if (!chapter) {
  console.error(`chapter not found: ${chapterName}`)
  process.exit(1)
}

const STICKY = {
  command:     { fill: '#cfe2ff', stroke: '#3d7bd9', label: 'command' },
  event:       { fill: '#ffd8a8', stroke: '#e8590c', label: 'event' },
  information: { fill: '#c3f0c8', stroke: '#2f9e44', label: 'read model' },
  ui:          { fill: '#e9ecef', stroke: '#868e96', label: 'screen' },
  automation:  { fill: '#e5dbff', stroke: '#7048e8', label: 'automation' },
  hotspot:     { fill: '#ffc9c9', stroke: '#e03131', label: 'hotspot' },
}
const STATUS = {
  draft: '#adb5bd', planned: '#4dabf7', 'in-progress': '#fab005',
  blocked: '#fa5252', ready: '#40c057', reviewed: '#12b886', deployed: '#087f5b',
}

const LANE_W = 150, COL_W = 176, HEAD_H = 58, TITLE_H = 44, PAD = 12
const STICKY_W = COL_W - 2 * PAD, STICKY_H = 74, GAP = 8

const slices = [...chapter.slices].sort((a, b) => a.index - b.index)
const lanes = [...chapter.lanes].sort((a, b) => a.index - b.index)
const cell = (laneId, sliceId) =>
  chapter.elements.filter((e) => e.laneId === laneId && e.sliceId === sliceId).sort((a, b) => a.index - b.index)
const laneH = lanes.map((l) =>
  Math.max(STICKY_H + 2 * PAD, ...slices.map((s) => cell(l.id, s.id).length * (STICKY_H + GAP) - GAP + 2 * PAD)))

const width = LANE_W + slices.length * COL_W + 1
const height = TITLE_H + HEAD_H + laneH.reduce((a, b) => a + b, 0) + 1

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// Up to two lines. Labels wrap on spaces; a single long camelCase name (e.g.
// courseCapacityWasChanged) is chunked at its humps so it stays inside the sticky.
const wrap = (text, max) => {
  const str = String(text)
  const words = /\s/.test(str) ? str.split(/\s+/) : [str]
  const lines = []
  for (const word of words) {
    const pieces = word.length <= max ? [word] : word.split(/(?=[A-Z])/)
    for (const piece of pieces) {
      const cur = lines[lines.length - 1]
      const joiner = pieces.length > 1 && cur !== undefined && !cur.endsWith(' ') ? '' : ' '
      if (cur !== undefined && (cur + joiner + piece).trim().length <= max) lines[lines.length - 1] = (cur + joiner + piece).trim()
      else lines.push(piece)
    }
    if (lines.length) lines[lines.length - 1] += ' '
  }
  return lines.map((l) => l.replace(/\s+/g, ' ').trim()).slice(0, 2)
}

const out = []
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`)
out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`)
out.push(`<text x="12" y="28" font-size="17" font-weight="bold" fill="#212529">${esc(title)}</text>`)

// slice headers
slices.forEach((s, i) => {
  const x = LANE_W + i * COL_W
  out.push(`<rect x="${x}" y="${TITLE_H}" width="${COL_W}" height="${HEAD_H}" fill="#f8f9fa" stroke="#dee2e6"/>`)
  wrap(s.label, 22).forEach((line, j) =>
    out.push(`<text x="${x + 8}" y="${TITLE_H + 19 + j * 15}" font-size="12" font-weight="bold" fill="#343a40">${esc(line)}</text>`))
  const color = STATUS[s.status] ?? '#adb5bd'
  out.push(`<rect x="${x + 8}" y="${TITLE_H + HEAD_H - 19}" width="${s.status.length * 6.4 + 14}" height="14" rx="7" fill="${color}"/>`)
  out.push(`<text x="${x + 15}" y="${TITLE_H + HEAD_H - 8.5}" font-size="9.5" fill="#fff" font-weight="bold">${esc(s.status)}</text>`)
})

// lanes + stickies
let y = TITLE_H + HEAD_H
lanes.forEach((l, li) => {
  const h = laneH[li]
  out.push(`<rect x="0" y="${y}" width="${LANE_W}" height="${h}" fill="#f1f3f5" stroke="#dee2e6"/>`)
  wrap(l.label, 18).forEach((line, j) =>
    out.push(`<text x="10" y="${y + 22 + j * 15}" font-size="12" font-weight="bold" fill="#495057">${esc(line)}</text>`))
  out.push(`<text x="10" y="${y + h - 10}" font-size="9.5" fill="#868e96">${esc(l.type)}</text>`)
  slices.forEach((s, si) => {
    const x = LANE_W + si * COL_W
    out.push(`<rect x="${x}" y="${y}" width="${COL_W}" height="${h}" fill="#ffffff" stroke="#e9ecef"/>`)
    cell(l.id, s.id).forEach((e, ei) => {
      const st = STICKY[e.type] ?? STICKY.hotspot
      const sx = x + PAD, sy = y + PAD + ei * (STICKY_H + GAP)
      const dash = e.copyOf ? ' stroke-dasharray="5 3"' : ''
      out.push(`<rect x="${sx}" y="${sy}" width="${STICKY_W}" height="${STICKY_H}" rx="4" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.6"${dash}/>`)
      out.push(`<text x="${sx + 7}" y="${sy + 14}" font-size="9" fill="${st.stroke}" font-weight="bold">${st.label.toUpperCase()}${e.copyOf ? ' · COPY' : ''}</text>`)
      wrap(e.name, 20).forEach((line, j) =>
        out.push(`<text x="${sx + 7}" y="${sy + 32 + j * 14}" font-size="12" fill="#212529">${esc(line)}</text>`))
      const fields = (e.fields ?? []).length
      const events = (e.dependencies ?? []).filter((d) => d.type === 'INBOUND' && d.elementType === 'EVENT').length
      const meta = [fields ? `${fields} fields` : '', e.type === 'information' && events ? `${events} event${events === 1 ? '' : 's'} in` : '']
        .filter(Boolean).join(' · ')
      if (meta) out.push(`<text x="${sx + 7}" y="${sy + STICKY_H - 7}" font-size="9" fill="#495057">${esc(meta)}</text>`)
    })
  })
  y += h
})
out.push('</svg>')

fs.writeFileSync(outPath, out.join('\n') + '\n')
console.log(`wrote ${outPath} (${slices.length} slices, ${chapter.elements.length} elements)`)
