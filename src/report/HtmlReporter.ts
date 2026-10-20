import { readFile, writeFile } from 'fs/promises'
import * as path from 'path'
import { RunReport, StepReport, BoundingBox } from '@types-local/index'
import { PliantError } from '@types-local/errors'
import { createLogger } from '@types-local/logger'

const logger = createLogger('HtmlReporter')

// ── public API ────────────────────────────────────────────────────────────────

export class HtmlReporter {
  async generate(runADir: string, runBDir: string, outputPath: string): Promise<void> {
    logger.info(`Loading run A from ${runADir}`)
    const [runA, scA] = await loadRun(runADir)
    logger.info(`Loading run B from ${runBDir}`)
    const [runB, scB] = await loadRun(runBDir)

    const html = buildHtml(runA, scA, runB, scB)
    await writeFile(outputPath, html, 'utf-8')
    logger.info(`Report written → ${outputPath}`)
  }

  // Single-run plan-vs-execution comparison.
  // Left column: planned intent + expect clauses.
  // Right column: actual outcome, matched element, healing events, assertion results.
  async generatePlanComparison(runDir: string, outputPath: string): Promise<void> {
    logger.info(`Loading run from ${runDir}`)
    const [report, screenshots] = await loadRun(runDir)
    const html = buildPlanComparisonHtml(report, screenshots)
    await writeFile(outputPath, html, 'utf-8')
    logger.info(`Plan comparison written → ${outputPath}`)
  }
}

// ── data loading ──────────────────────────────────────────────────────────────

interface Encoded { full: string | null; element: string | null }

async function loadRun(dir: string): Promise<[RunReport, Map<string, Encoded>]> {
  const raw = await readFile(path.join(dir, 'run.json'), 'utf-8')
  const parsed: unknown = JSON.parse(raw)
  if (!isRunReport(parsed)) throw new PliantError(`Invalid run.json in ${dir}`)

  const map = new Map<string, Encoded>()
  for (const step of parsed.steps) {
    map.set(step.stepId, {
      full:    await dataUri(step.screenshots.fullPage),
      element: step.screenshots.element ? await dataUri(step.screenshots.element) : null,
    })
  }
  return [parsed, map]
}

async function dataUri(filePath: string): Promise<string | null> {
  if (!filePath) return null
  try {
    const buf = await readFile(filePath)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

// ── serialised step record (passed to browser JS) ─────────────────────────────

interface BrowserStep {
  id: string
  intent: string
  runA: BrowserRun | null
  runB: BrowserRun | null
}

interface BrowserRun {
  outcome: string
  locator: string
  healingEvents: Array<{ type: string; description: string; confidence: number | null }>
  businessRule: {
    ruleId: string; formula: string; evaluatedFormula: string
    capturedValues: Record<string, number>; pass: boolean; toleranceApplied: number
    failReason: string | null
  } | null
  matchedElement: { confidence: number; reasoning: string; bb: BoundingBox | null } | null
  fullUri: string | null
  elementUri: string | null
}

function encodeBrowserStep(
  id: string,
  runA: RunReport, scA: Map<string, Encoded>,
  runB: RunReport, scB: Map<string, Encoded>,
): BrowserStep {
  const findStep = (r: RunReport) => r.steps.find(s => s.stepId === id) ?? null
  const intent = findStep(runA)?.intent ?? findStep(runB)?.intent ?? ''
  return {
    id, intent,
    runA: encodeBrowserRun(findStep(runA), scA.get(id) ?? null),
    runB: encodeBrowserRun(findStep(runB), scB.get(id) ?? null),
  }
}

function encodeBrowserRun(step: StepReport | null, sc: Encoded | null): BrowserRun | null {
  if (step === null) return null
  const rule = step.businessRule
  return {
    outcome: step.outcome,
    locator: step.locatorStrategy,
    healingEvents: step.healingEvents.map(e => ({
      type: e.type, description: e.description,
      confidence: e.confidence ?? null,
    })),
    businessRule: rule ? {
      ruleId: rule.ruleId, formula: rule.formula,
      evaluatedFormula: rule.evaluatedFormula,
      capturedValues: rule.capturedValues, pass: rule.pass,
      toleranceApplied: rule.toleranceApplied,
      failReason: rule.failReason ?? null,
    } : null,
    matchedElement: step.matchedElement ? {
      confidence: step.matchedElement.confidence,
      reasoning:  step.matchedElement.reasoning,
      bb:         step.matchedElement.boundingBox,
    } : null,
    fullUri:    sc?.full    ?? null,
    elementUri: sc?.element ?? null,
  }
}

// ── HTML assembly ─────────────────────────────────────────────────────────────

function buildHtml(
  runA: RunReport, scA: Map<string, Encoded>,
  runB: RunReport, scB: Map<string, Encoded>,
): string {
  const allIds = dedupe([
    ...runA.steps.map(s => s.stepId),
    ...runB.steps.map(s => s.stepId),
  ])
  const steps: BrowserStep[] = allIds.map(id => encodeBrowserStep(id, runA, scA, runB, scB))

  const planFile = path.basename(runA.planFile)
  const dateStr  = fmtDate(runA.startedAt)
  const sumA     = summary(runA)
  const sumB     = summary(runB)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pliant — ${esc(runA.site)} vs ${esc(runB.site)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="hdr-top">
    <span class="brand">Pliant</span>
    <span class="hdr-vs">${esc(runA.site)} <em>vs</em> ${esc(runB.site)}</span>
    <span class="hdr-meta">Plan: ${esc(planFile)} &nbsp;·&nbsp; ${esc(dateStr)}</span>
  </div>
  <div class="summary-bar">
    <span>${esc(runA.site)}: <strong>${sumA}</strong></span>
    <span class="sep">|</span>
    <span>${esc(runB.site)}: <strong>${sumB}</strong></span>
  </div>
</header>
<div class="layout">
  <aside id="step-list"></aside>
  <section id="panel">
    <div class="empty-state">← Select a step to view screenshots</div>
  </section>
</div>
<script>
const LABEL_A=${JSON.stringify(runA.site)};
const LABEL_B=${JSON.stringify(runB.site)};
const STEPS=${JSON.stringify(steps)};
${BROWSER_JS}
</script>
</body>
</html>`
}

// ── helpers ───────────────────────────────────────────────────────────────────

function summary(r: RunReport): string {
  const total  = r.steps.length
  const passed = r.steps.filter(s => s.outcome === 'PASS' || s.outcome === 'HEALED').length
  const healed = r.steps.filter(s => s.outcome === 'HEALED').length
  return `${passed}/${total} passed${healed ? ` (${healed} healed)` : ''}`
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

// ── type guards ───────────────────────────────────────────────────────────────

function isRunReport(v: unknown): v is RunReport {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['runId'] === 'string' && typeof o['site'] === 'string' &&
         typeof o['planFile'] === 'string' && Array.isArray(o['steps'])
}

// ── embedded CSS ──────────────────────────────────────────────────────────────

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#1a1a2e;background:#f0f2f5}
header{background:#1e2740;color:#fff;position:sticky;top:0;z-index:10}
.hdr-top{display:flex;align-items:center;gap:14px;padding:10px 18px}
.brand{font-weight:700;font-size:15px;letter-spacing:.5px}
.hdr-vs{font-size:14px;opacity:.9}
.hdr-vs em{font-style:normal;opacity:.6;margin:0 4px}
.hdr-meta{margin-left:auto;font-size:12px;opacity:.7}
.summary-bar{display:flex;align-items:center;gap:10px;padding:6px 18px;background:#16203a;font-size:12px}
.summary-bar .sep{opacity:.4}
.layout{display:grid;grid-template-columns:360px 1fr;height:calc(100vh - 62px)}
#step-list{overflow-y:auto;background:#fff;border-right:1px solid #dde4ee}
#panel{overflow:auto;padding:16px;background:#f0f2f5}
.empty-state{color:#999;font-size:14px;padding:40px;text-align:center}
/* step cards */
.card{padding:10px 14px;border-bottom:1px solid #edf0f7;cursor:pointer;transition:background .12s}
.card:hover{background:#f4f7fd}
.card.active{background:#e8f0fd;border-left:3px solid #3b82f6}
.card-header{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.step-num{font-weight:600;font-size:12px;color:#6b7280;white-space:nowrap}
.intent{font-size:12px;color:#374151;line-height:1.4;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* badges */
.badge{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:3px;white-space:nowrap}
.badge-PASS{background:#d1fae5;color:#065f46}
.badge-FAIL{background:#fee2e2;color:#991b1b}
.badge-HEALED{background:#fef3c7;color:#92400e}
.badge-SKIPPED{background:#f3f4f6;color:#6b7280}
.badge-STUCK{background:#fde8e8;color:#7f1d1d}
.badge-null{background:#f3f4f6;color:#9ca3af}
/* thumbnails */
.thumbs{display:flex;gap:6px;margin:4px 0}
.thumb-wrap{flex:1;position:relative;background:#e5e7eb;border-radius:3px;overflow:hidden;height:54px;display:flex;align-items:center;justify-content:center}
.thumb-wrap img{width:100%;height:100%;object-fit:cover}
.thumb-label{font-size:10px;color:#6b7280;margin-bottom:2px}
.thumb-missing{font-size:10px;color:#9ca3af;text-align:center;padding:4px}
/* healing */
.healing{background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:5px 7px;margin-top:4px;font-size:11px;color:#92400e}
.healing-event{margin-top:2px;padding-left:8px;border-left:2px solid #fcd34d}
/* business rule */
.brule{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;padding:5px 7px;margin-top:4px;font-size:11px;color:#14532d;font-family:monospace}
.brule-row{display:flex;gap:8px}
.brule-name{color:#4b5563;min-width:90px}
/* comparison panel */
.compare-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.compare-col h3{font-size:12px;font-weight:600;color:#374151;margin-bottom:6px;padding:4px 8px;background:#e8f0fd;border-radius:4px}
.img-wrap{position:relative;display:inline-block;width:100%}
.img-wrap img{width:100%;display:block;border-radius:4px;border:1px solid #dde4ee}
.bb-overlay{position:absolute;border:2px dashed #ef4444;background:rgba(239,68,68,.08);pointer-events:none}
.compare-missing{color:#9ca3af;font-size:12px;text-align:center;padding:40px 20px;background:#fff;border-radius:4px;border:1px dashed #dde4ee}
.panel-meta{margin-top:10px;font-size:11px;color:#6b7280}
`

// ── embedded browser JavaScript ───────────────────────────────────────────────

const BROWSER_JS = `
(function(){
  var list = document.getElementById('step-list');
  var panel = document.getElementById('panel');
  var activeIdx = -1;

  var OUTCOME_ICON = {PASS:'✓',FAIL:'✗',HEALED:'🔧',SKIPPED:'⏭',STUCK:'💥'};

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function badge(outcome){
    var icon = OUTCOME_ICON[outcome] || '—';
    var cls = 'badge badge-'+(outcome||'null');
    return '<span class="'+cls+'">'+icon+' '+(outcome||'—')+'</span>';
  }

  function thumb(uri, label){
    var lbl = '<div class="thumb-label">'+esc(label)+'</div>';
    if(!uri) return lbl+'<div class="thumb-missing">Not found</div>';
    return lbl+'<img src="'+uri+'" alt="'+esc(label)+' element">';
  }

  function healingHtml(events){
    if(!events || !events.length) return '';
    var rows = events.map(function(e){
      var conf = e.confidence !== null ? ' ('+Number(e.confidence).toFixed(2)+')' : '';
      return '<div class="healing-event">'+esc(e.type)+': '+esc(e.description)+conf+'</div>';
    }).join('');
    return '<div class="healing">🔧 Healed<br>'+rows+'</div>';
  }

  function bruleHtml(rA, rB){
    function side(label, run){
      if(!run || !run.businessRule) return '';
      var br = run.businessRule;
      var vals = Object.entries(br.capturedValues).map(function(kv){
        return '<div class="brule-row"><span class="brule-name">'+esc(kv[0])+'</span><span>'+kv[1]+'</span></div>';
      }).join('');
      var icon = br.pass ? '✓' : '✗';
      return '<div>'+esc(label)+': '+vals+esc(br.evaluatedFormula)+' '+icon+'</div>';
    }
    var aHtml = rA ? side(LABEL_A, rA) : '';
    var bHtml = rB ? side(LABEL_B, rB) : '';
    if(!aHtml && !bHtml) return '';
    return '<div class="brule">'+aHtml+bHtml+'</div>';
  }

  function renderList(){
    list.innerHTML = STEPS.map(function(step, i){
      var rA = step.runA, rB = step.runB;
      var healed = (rA && rA.outcome==='HEALED') || (rB && rB.outcome==='HEALED');
      return '<div class="card" id="c'+i+'" onclick="selectStep('+i+')">'
        +'<div class="card-header">'
        +'<span class="step-num">Step '+esc(step.id)+'</span>'
        +badge(rA ? rA.outcome : null)
        +badge(rB ? rB.outcome : null)
        +'</div>'
        +'<div class="intent">'+esc(step.intent)+'</div>'
        +'<div class="thumbs">'
        +'<div class="thumb-wrap">'+thumb(rA ? rA.elementUri : null, LABEL_A)+'</div>'
        +'<div class="thumb-wrap">'+thumb(rB ? rB.elementUri : null, LABEL_B)+'</div>'
        +'</div>'
        +(healed ? healingHtml((rA&&rA.healingEvents||[]).concat(rB&&rB.healingEvents||[])) : '')
        +bruleHtml(rA, rB)
        +'</div>';
    }).join('');
  }

  function imgCol(run, label){
    if(!run || !run.fullUri){
      return '<div class="compare-missing">No screenshot for '+esc(label)+'</div>';
    }
    var bbDiv = '';
    var img = '<img id="img-'+esc(label.replace(/\\s/g,''))+'" src="'+run.fullUri+'"'
      +' onload="positionBB(this)" data-bb="'+(run.matchedElement && run.matchedElement.bb ? encodeURIComponent(JSON.stringify(run.matchedElement.bb)) : '')+'">';
    return '<div class="img-wrap">'+img+(run.matchedElement && run.matchedElement.bb
      ? '<div class="bb-overlay" id="bb-'+esc(label.replace(/\\s/g,''))+'"></div>'
      : '')+'</div>';
  }

  function renderPanel(i){
    var step = STEPS[i];
    if(!step){ panel.innerHTML='<div class="empty-state">No data</div>'; return; }
    var rA = step.runA, rB = step.runB;
    var meta = '';
    if(rA && rA.matchedElement) meta += esc(LABEL_A)+': "'+esc(rA.matchedElement.reasoning)+'" ('+Number(rA.matchedElement.confidence).toFixed(2)+')  ';
    if(rB && rB.matchedElement) meta += esc(LABEL_B)+': "'+esc(rB.matchedElement.reasoning)+'" ('+Number(rB.matchedElement.confidence).toFixed(2)+')';
    panel.innerHTML = '<div class="compare-grid">'
      +'<div><h3>'+esc(LABEL_A)+'</h3>'+imgCol(rA, LABEL_A)+'</div>'
      +'<div><h3>'+esc(LABEL_B)+'</h3>'+imgCol(rB, LABEL_B)+'</div>'
      +'</div>'
      +(meta ? '<div class="panel-meta">'+meta+'</div>' : '');
  }

  window.positionBB = function(img){
    var encoded = img.getAttribute('data-bb');
    if(!encoded) return;
    var bb;
    try { bb = JSON.parse(decodeURIComponent(encoded)); } catch(e){ return; }
    var scale = img.offsetWidth / img.naturalWidth;
    var id = img.id.replace('img-','bb-');
    var overlay = document.getElementById(id);
    if(!overlay) return;
    overlay.style.left   = (bb.x * scale)+'px';
    overlay.style.top    = (bb.y * scale)+'px';
    overlay.style.width  = (bb.width * scale)+'px';
    overlay.style.height = (bb.height * scale)+'px';
  };

  window.selectStep = function(i){
    if(activeIdx >= 0){
      var old = document.getElementById('c'+activeIdx);
      if(old) old.classList.remove('active');
    }
    activeIdx = i;
    var card = document.getElementById('c'+i);
    if(card){ card.classList.add('active'); card.scrollIntoView({block:'nearest'}); }
    renderPanel(i);
  };

  renderList();
  if(STEPS.length > 0) window.selectStep(0);
}());
`

// ── plan-vs-execution comparison HTML ────────────────────────────────────────

interface PlanRow {
  stepNumber: number
  intent: string
  expects: string[]
  outcome: string
  matchedElement: { label: string | null; tag: string; confidence: number; reasoning: string } | null
  healingEvents: Array<{ type: string; description: string }>
  assertionResults: Array<{ expect: string; pass: boolean; reasoning: string }>
  businessRule: { formula: string; evaluatedFormula: string; pass: boolean; failReason: string | null } | null
  durationMs: number
  fullUri: string | null
}

function buildPlanComparisonHtml(report: RunReport, screenshots: Map<string, Encoded>): string {
  const rows: PlanRow[] = report.steps.map(s => {
    const sc = screenshots.get(s.stepId) ?? null
    return {
      stepNumber:       s.stepNumber,
      intent:           s.intent,
      expects:          s.assertions.map(a => a.expect),
      outcome:          s.outcome,
      matchedElement:   s.matchedElement ? {
        label:      s.matchedElement.label,
        tag:        s.matchedElement.tag,
        confidence: s.matchedElement.confidence,
        reasoning:  s.matchedElement.reasoning,
      } : null,
      healingEvents:    s.healingEvents.map(h => ({ type: h.type, description: h.description })),
      assertionResults: s.assertions,
      businessRule:     s.businessRule ? {
        formula:          s.businessRule.formula,
        evaluatedFormula: s.businessRule.evaluatedFormula,
        pass:             s.businessRule.pass,
        failReason:       s.businessRule.failReason ?? null,
      } : null,
      durationMs:       s.durationMs,
      fullUri:          sc?.full ?? null,
    }
  })

  const passCount = report.steps.filter(s => s.outcome === 'PASS' || s.outcome === 'HEALED').length
  const healCount = report.steps.filter(s => s.outcome === 'HEALED').length
  const date = fmtDate(report.startedAt)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pliant — Plan vs Execution: ${esc(report.site)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#1a1a2e;background:#f0f2f5}
header{background:#1e2740;color:#fff;padding:12px 20px;position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:16px}
.brand{font-weight:700;font-size:15px}
.hdr-title{font-size:14px;opacity:.9}
.hdr-meta{margin-left:auto;font-size:11px;opacity:.7}
.summary{background:#16203a;padding:6px 20px;font-size:12px;color:#d1d5db;display:flex;gap:20px}
.sum-item{display:flex;gap:6px;align-items:center}
table{width:100%;border-collapse:collapse;background:#fff}
thead th{background:#e8f0fd;font-weight:600;font-size:12px;padding:8px 10px;text-align:left;border-bottom:2px solid #c7d9f7;position:sticky;top:62px;z-index:5}
th.col-plan{width:38%}th.col-exec{width:32%}th.col-ss{width:30%}
tr:nth-child(even){background:#f9fafb}
tr:hover{background:#f0f6ff}
td{padding:8px 10px;vertical-align:top;border-bottom:1px solid #edf0f7;font-size:12px}
.step-num{font-weight:700;font-size:11px;color:#6b7280;white-space:nowrap}
.intent{font-weight:500;color:#1e293b;margin-bottom:4px;line-height:1.45}
.expects{margin-top:4px}
.expect-item{font-size:11px;color:#4b5563;padding:2px 0;display:flex;gap:4px}
.expect-icon{font-size:10px;min-width:12px}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 7px;border-radius:3px;margin-bottom:5px}
.badge-PASS{background:#d1fae5;color:#065f46}.badge-FAIL{background:#fee2e2;color:#991b1b}
.badge-HEALED{background:#fef3c7;color:#92400e}.badge-SKIPPED{background:#f3f4f6;color:#6b7280}
.badge-STUCK{background:#fde8e8;color:#7f1d1d}
.elem-info{font-size:11px;color:#374151;margin-bottom:4px}
.elem-tag{font-family:monospace;background:#e5e7eb;padding:0 3px;border-radius:2px}
.confidence{font-size:10px;color:#9ca3af}
.reasoning{font-size:11px;color:#6b7280;font-style:italic;margin-bottom:4px}
.healing{background:#fffbeb;border:1px solid #fde68a;border-radius:3px;padding:4px 6px;font-size:11px;color:#92400e;margin-bottom:4px}
.rule{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:3px;padding:4px 6px;font-size:11px;font-family:monospace;margin-bottom:4px}
.rule.fail{background:#fff1f2;border-color:#fecdd3;color:#9f1239}
.duration{font-size:10px;color:#d1d5db;text-align:right}
.ss-img{width:100%;border-radius:3px;border:1px solid #dde4ee;cursor:pointer}
.ss-missing{font-size:11px;color:#9ca3af;text-align:center;padding:16px;background:#f9fafb;border-radius:3px;border:1px dashed #dde4ee}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal-img{max-width:90vw;max-height:90vh;border-radius:4px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
</style>
</head>
<body>
<header>
  <span class="brand">Pliant</span>
  <span class="hdr-title">Plan vs Execution &nbsp;·&nbsp; ${esc(report.site)}</span>
  <span class="hdr-meta">${esc(report.planFile)} &nbsp;·&nbsp; ${esc(date)}</span>
</header>
<div class="summary">
  <span class="sum-item">Outcome: <strong>${esc(report.outcome)}</strong></span>
  <span class="sum-item">Steps passed: <strong>${passCount}/${report.steps.length}</strong></span>
  ${healCount > 0 ? `<span class="sum-item">Healed: <strong>${healCount}</strong></span>` : ''}
</div>
<div id="modal" class="modal-overlay" onclick="this.classList.remove('open')">
  <img class="modal-img" id="modal-img" src="" alt="full-page screenshot">
</div>
<table>
<thead><tr>
  <th class="col-plan"><span class="step-num">#</span>&nbsp; Plan step (intent + expects)</th>
  <th class="col-exec">Execution result</th>
  <th class="col-ss">Screenshot</th>
</tr></thead>
<tbody id="tbody"></tbody>
</table>
<script>
const ROWS = ${JSON.stringify(rows)};
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function badge(o){return '<span class="badge badge-'+esc(o)+'">'+esc(o)+'</span>';}
var ICONS={PASS:'✓',FAIL:'✗',HEALED:'⚠',SKIPPED:'⏭',STUCK:'💥'};
var tbody=document.getElementById('tbody');
tbody.innerHTML=ROWS.map(function(r){
  // Plan column
  var expects=r.expects.map(function(ex,i){
    var ar=r.assertionResults[i];
    var icon=ar?(ar.pass?'✓':'✗'):'·';
    var cls=ar?(ar.pass?'':'style="color:#991b1b"'):'';
    var tip=ar?(' title="'+esc(ar.reasoning)+'"'):'';
    return '<div class="expect-item"><span class="expect-icon">'+icon+'</span><span '+cls+tip+'>'+esc(ex)+'</span></div>';
  }).join('');
  var planCol='<td><span class="step-num">'+r.stepNumber+'</span>'
    +'<div class="intent">'+esc(r.intent)+'</div>'
    +(r.expects.length?'<div class="expects">'+expects+'</div>':'')
    +'</td>';

  // Execution column
  var elHtml='';
  if(r.matchedElement){
    var el=r.matchedElement;
    elHtml='<div class="elem-info"><span class="elem-tag">'+esc(el.tag)+'</span> '
      +esc((el.label||'').slice(0,50))
      +'<span class="confidence"> ('+Number(el.confidence).toFixed(2)+')</span></div>'
      +'<div class="reasoning">'+esc(el.reasoning)+'</div>';
  }
  var healHtml=(r.healingEvents||[]).map(function(h){
    return '<div class="healing">⚠ '+esc(h.type)+': '+esc(h.description)+'</div>';
  }).join('');
  var ruleHtml='';
  if(r.businessRule){
    var br=r.businessRule;
    var cls='rule'+(br.pass?'':' fail');
    ruleHtml='<div class="'+cls+'">'+esc(br.evaluatedFormula)+(br.pass?' ✓':' ✗')
      +(br.failReason?'<br>'+esc(br.failReason):'')+'</div>';
  }
  var dur='<div class="duration">'+r.durationMs+'ms</div>';
  var execCol='<td>'+badge(r.outcome)+elHtml+healHtml+ruleHtml+dur+'</td>';

  // Screenshot column
  var ssCol='<td>';
  if(r.fullUri){
    ssCol+='<img class="ss-img" src="'+r.fullUri+'" alt="step '+r.stepNumber+'" onclick="openModal(this.src)">';
  } else {
    ssCol+='<div class="ss-missing">No screenshot</div>';
  }
  ssCol+='</td>';

  return '<tr>'+planCol+execCol+ssCol+'</tr>';
}).join('');

function openModal(src){
  document.getElementById('modal-img').src=src;
  document.getElementById('modal').classList.add('open');
}
</script>
</body>
</html>`
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  function flag(name: string): string | null {
    const i = argv.indexOf(name)
    return i !== -1 ? argv[i + 1] ?? null : null
  }

  const runA  = flag('--run-a')
  const runB  = flag('--run-b')
  const out   = flag('--output') ?? './reports/comparison-report.html'

  if (!runA || !runB) {
    process.stderr.write('Usage: HtmlReporter --run-a <dir> --run-b <dir> [--output <file>]\n')
    process.exit(1)
  }

  await new HtmlReporter().generate(runA, runB, out)
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`Error: ${String(err)}\n`)
    process.exit(1)
  })
}
