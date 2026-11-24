const $ = id => document.getElementById(id);
const CACHE_KEY = 'pipeline.snapshot.v1';

const ACTIVE_LABELS = {
  convert: 'Converting',
  validate: 'Validating',
  describe: 'Describing',
  metadata: 'Preparing metadata',
  ready: 'Ready to upload',
  upload: 'Uploading',
  verify: 'Awaiting verification',
  verified: 'Verified',
  shorts: 'Waiting for matching clips',
  history: 'Retained history',
  attention: 'Needs attention',
};

const QUEUED_STATE_META = {
  server_ready: { label: 'Waiting · Convert', tone: 'process' },
  remuxed: { label: 'Waiting · Validate', tone: 'process' },
  artifact_valid: { label: 'Waiting · Describe', tone: 'process' },
  described: { label: 'Waiting · Metadata', tone: 'process' },
  metadata_ready: { label: 'Ready to upload', tone: 'upload' },
  upload_admitted: { label: 'Queued · Upload', tone: 'upload' },
  uploading: { label: 'Paused · Upload', tone: 'wait' },
  upload_uncertain: { label: 'Awaiting verification', tone: 'verify' },
  upload_verified: { label: 'Verified', tone: 'verified' },
  cleanup_eligible: { label: 'Verified', tone: 'verified' },
  short_waiting: { label: 'Short · waiting for match', tone: 'process' },
  short_joined: { label: 'Joined into batch', tone: 'process' },
  blocked: { label: 'Blocked', tone: 'issue' },
  failed: { label: 'Failed', tone: 'issue' },
};

const QUEUED_STAGE_META = {
  convert: { label: 'Waiting · Convert', tone: 'process' },
  validate: { label: 'Waiting · Validate', tone: 'process' },
  describe: { label: 'Waiting · Describe', tone: 'process' },
  metadata: { label: 'Waiting · Metadata', tone: 'process' },
  ready: { label: 'Ready to upload', tone: 'upload' },
  upload: { label: 'Queued · Upload', tone: 'upload' },
  verify: { label: 'Awaiting verification', tone: 'verify' },
  verified: { label: 'Verified', tone: 'verified' },
  shorts: { label: 'Short · waiting for match', tone: 'process' },
  attention: { label: 'Needs attention', tone: 'issue' },
};

const EVENT_STATE_META = {
  server_ready: { label: 'Queued for pipeline', tone: 'process', group: 'processing' },
  remuxed: { label: 'Converted', tone: 'process', group: 'processing' },
  artifact_valid: { label: 'Validated', tone: 'process', group: 'processing' },
  described: { label: 'Described', tone: 'process', group: 'processing' },
  metadata_ready: { label: 'Metadata ready', tone: 'process', group: 'processing' },
  upload_admitted: { label: 'Budget reserved', tone: 'upload', group: 'uploads' },
  uploading: { label: 'Upload started', tone: 'upload', group: 'uploads' },
  upload_uncertain: { label: 'Submitted · verify pending', tone: 'verify', group: 'uploads' },
  uploaded: { label: 'Upload accepted', tone: 'upload', group: 'uploads' },
  upload_verified: { label: 'Verified online', tone: 'verified', group: 'uploads' },
  cleanup_eligible: { label: 'Cleanup ready', tone: 'verified', group: 'uploads' },
  short_waiting: { label: 'Short queued', tone: 'process', group: 'processing' },
  short_joined: { label: 'Joined into batch', tone: 'process', group: 'processing' },
  short_cancelled: { label: 'Short batch cancelled', tone: 'wait', group: 'processing' },
  blocked: { label: 'Blocked', tone: 'issue', group: 'issues' },
  failed: { label: 'Failed', tone: 'issue', group: 'issues' },
};

const BOILERPLATE_REASONS = new Set([
  'upload attempt started',
  'upload bytes reserved',
  'monthly bytes reserved',
  'upload metadata composed',
  'description persisted for artifact hash',
  'artifact hash and validation persisted',
  'all required parts verified online',
]);

const SERVICE_NAMES = {
  'video-downloader': 'Recorder',
  'video-server': 'Library & finalization',
  'video-auth': 'Authentication',
  'video-pipeline': 'Conversion & uploads',
  'video-xvfb': 'Browser session',
};

let data = null, live = false, page = 'overview', filter = 'next', activityFilter = 'all';
let shown = 40, timer = null, pending = null, generation = 0;
let queueSignature = null, activitySignature = null;
const num = new Intl.NumberFormat('en');

export function bytes(n, precision = 1) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(precision)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(precision)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(precision)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

export function duration(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  n = Math.max(0, Math.round(n));
  if (n >= 3600) return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
  if (n >= 60) return `${Math.floor(n / 60)}m ${n % 60}s`;
  return `${n}s`;
}

function time(value, withDate = false) {
  const d = new Date(value);
  return Number.isNaN(d.valueOf())
    ? '—'
    : new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Tirane',
        ...(withDate ? { day: 'numeric', month: 'short' } : {}),
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
}

function date(value) {
  const d = new Date(String(value).slice(0, 10) + 'T12:00:00Z');
  return Number.isNaN(d.valueOf())
    ? '—'
    : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Tirane' }).format(d);
}

function ago(value) {
  const n = (Date.now() - new Date(value).valueOf()) / 1000;
  if (!Number.isFinite(n)) return '—';
  if (n < 0) return `in ${duration(-n)}`;
  return n < 10 ? 'just now' : n < 60 ? `${Math.floor(n)}s ago` : n < 3600 ? `${Math.floor(n / 60)}m ago` : n < 86400 ? `${Math.floor(n / 3600)}h ago` : `${Math.floor(n / 86400)}d ago`;
}

function el(tag, className, textValue) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (textValue !== undefined) n.textContent = String(textValue);
  return n;
}

function text(id, value) { $(id).textContent = value; }

// A site's badge: its ID, coloured by its place in the sites file.
function provider(name) {
  const index = (data?.sources || []).indexOf(name);
  return el('span', 'provider' + (index >= 0 ? ' p' + (index % 6) : ''), name ? name.toUpperCase() : 'LOCAL');
}

function pill(label, tone) {
  return el('span', 'stage-pill' + (tone ? ' ' + tone : ''), label);
}

function empty(message) { return el('p', 'empty-inline', message); }
function formatCount(n) { return n === null || n === undefined ? '—' : num.format(n); }

function working() {
  return data?.services['video-pipeline']?.state === 'active'
    && !['user_paused', 'paused', 'worker_stopped', 'worker_unresponsive', 'status_unavailable', 'cooldown'].includes(data.campaign.state);
}

function queueStatusFor(row, isCurrent, isWorking) {
  if (isWorking) {
    const activeStage = ACTIVE_LABELS[row.stage] || row.stage || 'Working';
    return { label: `Working · ${activeStage}`, tone: 'live' };
  }
  if (isCurrent) return { label: `Last active · ${ACTIVE_LABELS[row.stage] || row.stage}`, tone: 'wait' };
  if (row.clips && row.stage === 'verified') return { label: `Verified · ${row.clips} clips`, tone: 'verified' };
  if (row.clips) return { label: `${row.clips} clips · ${QUEUED_STATE_META[row.state]?.label || ACTIVE_LABELS[row.stage] || row.stage}`, tone: 'process' };
  if (row.state && QUEUED_STATE_META[row.state]) return QUEUED_STATE_META[row.state];
  if (row.stage && QUEUED_STAGE_META[row.stage]) return QUEUED_STAGE_META[row.stage];
  return { label: ACTIVE_LABELS[row.stage] || row.stage || 'Queued', tone: 'process' };
}

function eventMetaFor(entry) {
  if (entry.to_state === 'blocked' && /removed video \S+ after /i.test(entry.reason || '')) {
    return { label: 'Removed by provider', tone: 'wait', group: 'uploads' };
  }
  if (entry.to_state && EVENT_STATE_META[entry.to_state]) return EVENT_STATE_META[entry.to_state];
  const fallbackStage = entry.stage || 'process';
  const tone = fallbackStage === 'verified' ? 'verified' : fallbackStage === 'upload' ? 'upload' : fallbackStage === 'verify' ? 'verify' : fallbackStage === 'attention' ? 'issue' : 'process';
  const group = fallbackStage === 'attention' ? 'issues' : ['upload', 'verify', 'verified'].includes(fallbackStage) ? 'uploads' : 'processing';
  return { label: ACTIVE_LABELS[fallbackStage] || fallbackStage, tone, group };
}

function displayPath(row) {
  return row.source_path || row.recording || row.id || '—';
}

function setPathContent(node, value) {
  node.replaceChildren();
  const raw = String(value || '');
  if (!raw) return;
  const parts = raw.split('/');
  for (let i = 0; i < parts.length; i++) {
    const segment = i < parts.length - 1 ? parts[i] + '/' : parts[i];
    if (segment) node.append(document.createTextNode(segment));
    if (i < parts.length - 1) node.append(document.createElement('wbr'));
  }
}

function pathBox(value) {
  const box = el('div', 'path-box');
  setPathContent(box, value);
  return box;
}

function setConnection(ok, message) {
  live = ok;
  document.body.classList.toggle('saved-data', !ok);
  $('refresh').classList.toggle('offline', !ok);
  text('connection-label', ok ? 'Live' : data ? 'Saved' : 'Offline');
  $('connection-banner').hidden = ok;
  if (!ok) text('connection-banner', message || `Connection interrupted. Showing the last snapshot from ${data ? time(data.generated_at, true) : 'this phone'}.`);
}

function renderHero() {
  const a = data.active, c = data.campaign, state = c.state;
  const paused = ['user_paused', 'paused', 'worker_stopped', 'worker_unresponsive'].includes(state);
  $('now-card').classList.toggle('paused', paused);

  let title = a ? (ACTIVE_LABELS[a.stage] || 'Working') : 'Idle';
  let tag = a ? (ACTIVE_LABELS[a.stage] || 'WORKING') : 'PIPELINE RUNNING';
  if (a?.stage === 'upload' && a.progress?.percent >= 100) {
    title = a.phase === 'metadata_submitting' ? 'Publishing metadata' : 'Finishing upload';
    tag = a.phase === 'metadata_submitting' ? 'SUBMITTING DETAILS' : 'PROVIDER ASSEMBLY';
  }
  if (state === 'user_paused' || state === 'paused') { title = 'Paused'; tag = 'UPLOAD WORKER PAUSED'; }
  if (state === 'worker_stopped') { title = 'Worker stopped'; tag = 'UPLOAD WORKER OFFLINE'; }
  if (state === 'worker_unresponsive') { title = 'Worker unresponsive'; tag = 'HEARTBEAT LATE'; }
  if (state === 'cooldown') { title = 'Retry scheduled'; tag = 'AUTOMATIC RETRY'; }
  if (state === 'upload_quota_wait') { title = 'Waiting for allowance'; tag = 'AUTOMATIC BUDGET WAIT'; }
  if (state === 'resource_wait') { title = 'Waiting for resources'; tag = 'RESOURCE WAIT'; }
  if (state === 'uploads_held' && !a) { title = 'Uploads held'; tag = 'CONVERTING AHEAD'; }
  if (state === 'uploads_held' && a) { tag = 'UPLOADS HELD · CONVERTING'; }
  if (state === 'full_ahead') { title = 'Converted ahead to the cap'; tag = 'WAITING FOR UPLOADS'; }
  if (state === 'status_unavailable') { title = 'Worker status unavailable'; tag = 'SERVICE STATUS UNAVAILABLE'; }
  if (state === 'finishing') { tag = 'FINISHING ACTIVE WORK'; }

  text('now-state', live ? tag.toUpperCase() : `LAST SEEN · ${tag.toUpperCase()}`);
  text('now-title', title);
  text('now-generated-title', a ? (a.generated_title || 'Title will appear after description.') : '');
  $('now-generated-title').classList.toggle('pending-title', Boolean(a && !a.generated_title));
  setPathContent($('now-source-path'), a ? (a.source_path || a.id) : '');

  const detail = $('now-detail');
  detail.replaceChildren();
  if (a) {
    if (a.provider) detail.append(provider(a.provider));
    const parts = [duration(a.seconds)];
    if (a.size_bytes) parts.push(bytes(a.size_bytes));
    parts.push(`captured ${date(a.captured_at)}`);
    detail.append(document.createTextNode(parts.join(' · ')));
  } else if (state === 'user_paused' || state === 'paused') {
    detail.textContent = `${data.counts.capturing} live recording${data.counts.capturing === 1 ? '' : 's'} · capture stays independent`;
  } else if (state === 'worker_stopped') {
    detail.textContent = 'Queue and completed work are preserved.';
  } else if (state === 'worker_unresponsive') {
    detail.textContent = `Last heartbeat ${ago(c.worker_heartbeat)}. Queue snapshot is preserved.`;
  } else if (state === 'cooldown') {
    detail.textContent = `Next retry ${time(c.resume_at, true)}.`;
  } else if (state === 'upload_quota_wait') {
    detail.textContent = `Next allowance release ${date(data.budget.next_release)}. Resumes automatically.`;
  } else if (state === 'uploads_held') {
    detail.textContent = `Uploads held: ${data.ahead?.uploads_held || c.attention || 'retry scheduled'}. Conversion continues.`;
  } else if (state === 'full_ahead') {
    detail.textContent = `${bytes(data.ahead?.ready_bytes || 0, 0)} converted and waiting (cap ${bytes(data.ahead?.limit_bytes || 0, 0)}). Conversion resumes as files upload.`;
  } else if (state === 'resource_wait') {
    detail.textContent = c.step?.reason || 'Waiting for disk/CPU room before starting the next stage.';
  } else if (state === 'status_unavailable') {
    detail.textContent = 'Queue snapshot is available; live worker status check is temporarily unavailable.';
  } else {
    detail.textContent = `${data.counts.capturing} recording${data.counts.capturing === 1 ? '' : 's'} live · ${formatCount(data.counts.ready)} queued · ${formatCount(data.counts.verified)} verified`;
  }

  const elapsed = a?.started_at ? (Date.now() - new Date(a.started_at).valueOf()) / 1000 : null;
  text('job-elapsed', a && !paused ? `${duration(elapsed)} elapsed` : '');

  const p = a?.progress;
  $('job-progress').classList.toggle('indeterminate', Boolean(a && !p && !paused));
  $('job-fill').style.width = p ? `${Math.min(100, Math.max(0, p.percent))}%` : paused ? '0%' : '';
  text('progress-number', p ? `${p.percent.toFixed(1)}%` : a && !paused ? 'In progress' : '');
  text(
    'progress-detail',
    p
      ? `${bytes(p.acknowledged_bytes)} of ${bytes(p.total_bytes)} acknowledged`
      : a?.stage === 'convert' && a.output_bytes
        ? `${bytes(a.output_bytes)} written so far`
        : a && !paused
          ? `Processing ${a.size_bytes ? bytes(a.size_bytes) + ' · ' : ''}${duration(a.seconds)} of footage`
          : paused
            ? 'Work resumes when the upload worker is enabled.'
            : 'Watching for the next finalized recording.',
  );

  const extras = [];
  if (p) {
    if (!p.fresh) extras.push(`Last progress ${ago(p.updated_at)}`);
    else if (p.percent >= 100) extras.push('File transfer complete; provider processing and verification follow.');
    else if (p.bytes_per_second) extras.push(`${((p.bytes_per_second * 8) / 1e6).toFixed(1)} Mbps · ~${duration(p.eta_seconds)} left`);
    if (p.percent < 100) extras.push('Online verification follows upload.');
  } else if (a?.stage === 'upload') {
    extras.push('Transfer active; awaiting first acknowledged byte update.');
  }
  if (a?.reservation_month && a.reservation_month !== data.budget.month) {
    extras.push(`Budgeted in ${new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date(a.reservation_month + '-15T12:00:00Z'))}.`);
  }
  text('job-extra', extras.join(' '));
}

function renderStages() {
  const c = data.counts, a = working() ? data.active : null;
  const queuedConvert = data.queue.filter(r => ['convert', 'validate'].includes(r.stage)).length;
  const queuedDescribe = data.queue.filter(r => ['describe', 'metadata'].includes(r.stage)).length;
  const queuedUpload = data.queue.filter(r => ['upload', 'ready'].includes(r.stage)).length;
  const specs = [
    ['capture', '◉', 'Record', c.capturing, c.capturing > 0, false, c.capturing ? 'recording' : 'idle'],
    ['finalize', '◇', 'Finalize', data.finalization.processing, data.finalization.processing > 0, false, data.finalization.completed24 ? `${formatCount(data.finalization.completed24)} in 24h` : ''],
    ['convert', '◫', 'Convert', a && ['convert', 'validate'].includes(a.stage) ? 1 : 0, a && ['convert', 'validate'].includes(a.stage), false, queuedConvert ? `${formatCount(queuedConvert)} queued` : ''],
    ['describe', '✧', 'Describe', a && ['describe', 'metadata'].includes(a.stage) ? 1 : 0, a && ['describe', 'metadata'].includes(a.stage), false, queuedDescribe ? `${formatCount(queuedDescribe)} queued` : ''],
    ['upload', '↑', 'Upload', a?.stage === 'upload' ? 1 : 0, a?.stage === 'upload', false, queuedUpload ? `${formatCount(queuedUpload)} ready` : ''],
    ['verify', '✓', 'Verify', c.confirming, false, c.confirming > 0, c.confirming ? 'pending check' : ''],
  ];

  const map = $('pipeline-map');
  map.replaceChildren();
  for (const [key, icon, label, count, active, waiting, sub] of specs) {
    const n = el('button', 'pipe-node' + (active ? ' active' : '') + (waiting ? ' waiting' : ''));
    n.setAttribute('aria-label', `${label}: ${formatCount(count)}${active ? ' active' : ''}${sub ? ', ' + sub : ''}`);
    const top = el('div', 'node-top');
    top.append(el('span', 'node-icon', icon), el('span', 'node-light'));
    const body = el('div');
    body.append(el('strong', '', formatCount(count)), el('span', 'node-label', label));
    if (sub) body.append(el('span', 'node-sub', sub));
    n.append(top, body);
    n.addEventListener('click', () => {
      if (key === 'capture' || key === 'finalize') $('capture-strip').scrollIntoView({ behavior: 'smooth', block: 'center' });
      else openQueue(key === 'verify' ? 'verify' : key);
    });
    map.append(n);
  }

  const list = $('capture-strip');
  list.replaceChildren();
  if (!data.captures.length) list.append(empty('No streams recording right now.'));
  for (const capture of data.captures.slice(0, 6)) {
    const row = el('div', 'capture-line');
    row.append(
      provider(capture.provider),
      el('span', 'alias', capture.alias),
      el('span', 'capture-time', capture.active ? `${duration(capture.seconds)} · ${formatCount(capture.segments)} segs` : 'Waiting for stream'),
    );
    list.append(row);
  }
  if (data.captures.length > 6) list.append(empty(`+ ${data.captures.length - 6} more live recordings`));
}

function renderUpNext() {
  const panel = $('up-next-panel');
  const list = $('up-next-list');
  list.replaceChildren();
  const nextItems = data.queue.slice(0, 3);
  panel.hidden = nextItems.length === 0;
  for (const [i, r] of nextItems.entries()) {
    const item = el('div', 'up-next-item');
    const head = el('div', 'up-next-head');
    const left = el('div', 'up-next-left');
    left.append(el('span', 'up-next-pos', `#${String(i + 1).padStart(2, '0')}`));
    if (r.provider) left.append(provider(r.provider));
    left.append(el('span', 'up-next-dur', `${duration(r.seconds)}${r.size_bytes ? ' · ' + bytes(r.size_bytes) : ''}`));
    const status = queueStatusFor(r, false, false);
    head.append(left, pill(status.label, status.tone));
    item.append(head, pathBox(displayPath(r)));
    list.append(item);
  }
}

function renderBudget() {
  const b = data.budget;
  const month = new Date(b.month + '-15T12:00:00Z');
  text('budget-month', new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/Tirane' }).format(month).toUpperCase() + ' · ALLOWANCE');
  text('budget-remaining', bytes(b.remaining, 0));
  $('released-ring').setAttribute('stroke-dasharray', `${Math.min(100, (b.released / b.month_total) * 100)} 100`);
  $('used-ring').setAttribute('stroke-dasharray', `${Math.min(100, ((b.spent + b.reserved) / b.released) * 100)} 100`);
  $('used-ring').style.opacity = b.spent + b.reserved > 0 ? '1' : '0';

  const numbers = $('budget-numbers');
  numbers.replaceChildren();
  for (const [value, label] of [
    [bytes(b.released, 0), 'Released so far'],
    [b.spent ? bytes(b.spent) : '0 GB', 'Spent (incl. retries)'],
    [b.reserved ? bytes(b.reserved) : '0 GB', 'Reserved for active'],
  ]) {
    const n = el('div', 'budget-value');
    n.append(el('strong', '', value), el('span', '', label));
    numbers.append(n);
  }

  // One row per uplink (home first): sent today against its daily cap, and what is left.
  const schedule = $('release-schedule');
  schedule.replaceChildren();
  for (const u of b.uplinks) {
    const n = el('div', 'release-step' + (u.remaining > 0 ? ' current' : ''));
    n.append(el('span', '', `${u.id.toUpperCase()} · TODAY`),
      el('strong', '', `${bytes(u.spent_today, 0)} / ${bytes(2 * u.daily, 0)}`));
    const left = el('div', 'release-step');
    left.append(el('span', '', `${u.id.toUpperCase()} · LEFT`), el('strong', '', bytes(u.remaining, 0)));
    const month = el('div', 'release-step');
    month.append(el('span', '', `${u.id.toUpperCase()} · MONTH`), el('strong', '', bytes(u.available, 0)));
    schedule.append(n, left, month);
  }
  const ahead = data.ahead ? ` Converted ahead: ${bytes(data.ahead.ready_bytes, 0)} of ${bytes(data.ahead.limit_bytes, 0)}${data.ahead.uploads_held ? ` · uploads held (${data.ahead.uploads_held})` : ''}.` : '';
  text('budget-note', `${bytes(b.daily, 0)} more at midnight (${date(b.next_release)}). Unused allowance carries over within the month; at most ${bytes(2 * b.daily, 0)} a day.${ahead}`);
}

// The carrier drive: where it is, what it holds for the office, what waits for it.
function renderCarrier() {
  const k = data.carrier;
  $('carrier-block').hidden = !k;
  if (!k) return;
  const where = { home: 'IN THE PC', away: 'AWAY', uplink: 'AT THE OFFICE' }[k.location] || 'NOT SEEN YET';
  text('carrier-where', `${k.id} · ${where}${k.seen_at ? ' · ' + ago(k.seen_at) : ''}`);
  const numbers = $('carrier-numbers');
  numbers.replaceChildren();
  for (const [value, label] of [
    [bytes(k.on_drive_bytes, 0), `On it (${k.files} file${k.files === 1 ? '' : 's'})`],
    [bytes(k.waiting_bytes, 0), 'Waiting for it'],
    [k.free_bytes === null ? '—' : bytes(k.free_bytes, 0), 'Free on it'],
  ]) {
    const n = el('div', 'budget-value');
    n.append(el('strong', '', value), el('span', '', label));
    numbers.append(n);
  }
  const notes = { ready: 'Ready: it may be pulled at any moment.', full: 'Full: take it to the office.',
    unknown: 'This drive is not set up as the carrier (carrier-init).', done: 'The office sent everything: bring it home.' };
  text('carrier-note', [notes[k.notice] || '', k.note || ''].filter(Boolean).join(' '));
}

function svgNode(name, attributes) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes || {})) n.setAttribute(key, String(value));
  return n;
}

function renderHistory() {
  const days = data.history;
  const max = Math.max(1, ...days.flatMap(d => [d.submitted, d.verified]));
  const totals = { submitted: days.reduce((s, d) => s + d.submitted, 0), verified: days.reduce((s, d) => s + d.verified, 0) };
  const top = $('history-totals');
  top.replaceChildren();
  for (const [key, label] of [['submitted', 'Submitted (14d)'], ['verified', 'Verified (14d)']]) {
    const n = el('div', 'history-total');
    n.append(el('strong', '', formatCount(totals[key])), el('span', '', label));
    top.append(n);
  }
  const svg = svgNode('svg', { viewBox: '0 0 320 128', 'aria-hidden': 'true' });
  for (const y of [10, 50, 90]) svg.append(svgNode('line', { x1: 0, y1: y, x2: 320, y2: y, stroke: '#253545', 'stroke-dasharray': '2 5' }));
  for (const [i, day] of days.entries()) {
    const x = i * 23;
    for (const [j, key, color] of [[0, 'submitted', '#b8a4ff'], [1, 'verified', '#6ee7c0']]) {
      const h = (day[key] / max) * 78;
      const rect = svgNode('rect', { x: x + j * 8 + 2, y: 90 - Math.max(2, h), width: 6, height: Math.max(2, h), rx: 2, fill: color, opacity: day[key] ? 1 : 0.2 });
      const title = svgNode('title');
      title.textContent = `${day.date}: ${day[key]} ${key}`;
      rect.append(title);
      svg.append(rect);
    }
    if (i === 0 || i === 6 || i === 13) {
      const t = svgNode('text', { x: x + 7, y: 116, fill: '#8ea2b5', 'font-size': 9, 'text-anchor': i === 0 ? 'start' : i === 13 ? 'end' : 'middle' });
      t.textContent = day.date.slice(8) + ' ' + new Intl.DateTimeFormat('en', { month: 'short' }).format(new Date(day.date + 'T12:00:00Z'));
      svg.append(t);
    }
  }
  $('history-chart').replaceChildren(svg);
  $('history-chart').setAttribute('aria-label', `Last fourteen days: ${totals.submitted} submissions and ${totals.verified} verified copies. ${days.map(d => `${d.date}: ${d.submitted} submitted, ${d.verified} verified`).join('. ')}`);
}

function renderShorts() {
  const pendingBatches = data.shorts.batches.filter(b => b.stage !== 'verified');
  const summary = $('shorts-summary');
  summary.replaceChildren();
  for (const [count, label] of [
    [data.counts.short_waiting, 'clips waiting for match'],
    [pendingBatches.length, 'active batches'],
    [data.counts.prepared_batches - pendingBatches.length, 'verified batches'],
  ]) {
    const n = el('div', 'short-tile');
    n.append(el('strong', '', formatCount(count)), el('span', '', label));
    summary.append(n);
  }
  const batches = $('short-batches');
  batches.replaceChildren();
  const displayBatches = (pendingBatches.length ? pendingBatches : data.shorts.batches).slice(0, 4);
  for (const b of displayBatches) {
    const n = el('div', 'batch-row');
    const left = el('div');
    left.append(el('strong', '', b.alias), el('small', '', `${b.clips} clips · ${b.orientation}`));
    const parts = el('div', 'batch-parts');
    for (let i = 0; i < Math.min(12, b.clips); i++) parts.append(el('span', 'batch-part'));
    left.append(parts);
    const meta = el('div', 'batch-meta');
    meta.append(el('span', 'batch-dur', duration(b.seconds)));
    const st = queueStatusFor(b, false, false);
    meta.append(pill(b.stage === 'verified' ? 'Verified' : st.label, st.tone));
    n.append(left, meta);
    batches.append(n);
  }
  if (!displayBatches.length) batches.append(empty('Matching short clips will form batches automatically.'));
}

function renderStorage() {
  const s = data.storage, inv = s.inventory || {}, used = s.total - s.free;
  text('disk-free', `${bytes(s.free, 0)} free`);
  const rail = $('storage-rail'), legend = $('storage-legend');
  rail.replaceChildren();
  legend.replaceChildren();
  for (const [value, color] of [[used, '#7bb8ff'], [s.free, '#6ee7c0']]) {
    const segment = el('span', 'storage-segment');
    segment.style.width = `${Math.max(0, (value / s.total) * 100)}%`;
    segment.style.background = color;
    rail.append(segment);
  }
  const rows = [
    ['Disk used', used, '#7bb8ff'],
    ['Available', s.free, '#6ee7c0'],
    ['Recordings', inv.downloads, '#7bb8ff'],
    ['Conversions', inv.artifacts, '#b8a4ff'],
    ['Review & Trash', inv.retained_trash === undefined ? undefined : inv.retained_trash + (inv.desktop_staging || 0), '#f0c674'],
  ];
  for (const [label, value, color] of rows) {
    if (value === null || value === undefined) continue;
    const n = el('div', 'storage-key'), key = el('span'), dot = el('i');
    dot.style.background = color;
    key.append(dot, document.createTextNode(label));
    n.append(key, el('strong', '', bytes(value)));
    legend.append(n);
  }
  text('storage-note', `Bar and disk totals are live. Folder sizes ${s.inventory_at ? 'last measured ' + time(s.inventory_at, true) : 'are unavailable'}.`);
}

function renderServices() {
  const list = $('services');
  list.replaceChildren();
  for (const [id, label] of Object.entries({ ...SERVICE_NAMES, ...(data.service_labels || {}) })) {
    const s = data.services[id] || { state: 'unknown' };
    const row = el('div', 'service-row');
    const dot = el('span', 'service-light' + (s.state === 'active' ? '' : s.state === 'unknown' ? ' unknown' : ' stopped'));
    const name = el('div', '', label);
    name.append(el('small', '', s.state === 'active' ? `Up ${duration(s.uptime_seconds)}` : s.state === 'inactive' && id === 'video-pipeline' ? 'Stopped · manual control' : s.state));
    const values = el('div', 'service-values', s.cpu_percent === null || s.cpu_percent === undefined ? 'CPU —' : `${s.cpu_percent.toFixed(1)}% CPU`);
    values.append(el('small', '', bytes(s.anonymous_bytes)));
    row.append(dot, name, values);
    list.append(row);
  }
  if (data.authentication?.checked_at) {
    const auth = data.authentication;
    const row = el('div', 'service-row');
    row.append(
      el('span', 'service-light' + (auth.confirmed ? '' : ' stopped')),
      (() => {
        const d = el('div', '', `${(data.destination || 'Destination').toUpperCase()} session`);
        d.append(el('small', '', auth.confirmed ? `Logged in · checked ${ago(auth.checked_at)}` : `Session check failed · ${ago(auth.checked_at)}`));
        return d;
      })(),
      el('div', 'service-values', auth.confirmed ? 'OK' : 'Check'),
    );
    list.append(row);
  }
  text('retained-summary', `${formatCount(data.health.historical_removals)} provider removals · excluded from re-upload`);
  text('monitoring-note', `Babysitting: ${data.monitoring.cadence || 'scheduled'}. Last check ${data.monitoring.last_check ? time(data.monitoring.last_check, true) : 'not yet recorded'}. Service RAM excludes file cache.`);
}

function renderQueue() {
  if (!data) return;
  const signature = JSON.stringify([filter, shown, $('queue-search').value, working(), data.active?.id, data.active?.stage, data.active?.progress?.percent, data.queue, data.confirmations, data.shorts]);
  if (signature === queueSignature) return;
  queueSignature = signature;

  const anchor = page === 'queue' ? [...document.querySelectorAll('.queue-row')].find(n => n.getBoundingClientRect().bottom > 20) : null;
  const anchorId = anchor?.dataset.id, anchorTop = anchor?.getBoundingClientRect().top;

  const nextAll = [...(data.active ? [data.active] : []), ...data.queue];
  const verifyAll = data.confirmations.map(r => ({
    id: r.recording_id,
    alias: r.alias,
    source_path: r.source_path,
    provider: r.provider,
    seconds: r.seconds,
    captured_at: r.captured_at,
    generated_title: r.generated_title,
    size_bytes: r.size_bytes,
    state: 'upload_uncertain',
    stage: 'verify',
    confirm_after: r.confirm_after,
    remote_id: r.remote_id,
  }));
  const shortsAll = [...data.shorts.waiting, ...data.shorts.batches];

  const filters = [
    ['next', 'Next up', nextAll.length],
    ['verify', 'Verifying', verifyAll.length],
    ['shorts', 'Shorts', shortsAll.length],
  ];
  if (!filters.some(([key]) => key === filter)) {
    const extraCount = filter === 'convert'
      ? nextAll.filter(r => ['convert', 'validate'].includes(r.stage)).length
      : filter === 'describe'
        ? nextAll.filter(r => ['describe', 'metadata'].includes(r.stage)).length
        : nextAll.filter(r => ['upload', 'ready'].includes(r.stage)).length;
    filters.push([filter, filter === 'convert' ? 'Convert' : filter === 'describe' ? 'Describe' : 'Upload', extraCount]);
  }

  const controls = $('queue-filters');
  controls.replaceChildren();
  for (const [key, label, count] of filters) {
    const b = el('button', key === filter ? 'selected' : '');
    b.setAttribute('aria-pressed', String(key === filter));
    b.append(document.createTextNode(label), el('span', 'filter-count', formatCount(count)));
    b.addEventListener('click', () => { filter = key; shown = 40; renderQueue(); });
    controls.append(b);
  }

  let rows = [];
  if (filter === 'shorts') rows = shortsAll;
  else if (filter === 'verify') rows = verifyAll;
  else {
    rows = nextAll;
    if (filter === 'convert') rows = rows.filter(r => ['convert', 'validate'].includes(r.stage));
    else if (filter === 'describe') rows = rows.filter(r => ['describe', 'metadata'].includes(r.stage));
    else if (filter === 'upload') rows = rows.filter(r => ['upload', 'ready'].includes(r.stage));
  }

  const query = $('queue-search').value.trim().toLocaleLowerCase();
  if (query) {
    rows = rows.filter(r => [r.source_path, r.alias, r.id, r.provider, r.generated_title, r.remote_id]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  }

  text(
    'queue-count',
    `${num.format(rows.length)} ${filter === 'shorts' ? 'clips and batches' : filter === 'verify' ? 'uploads awaiting verification' : 'jobs'}${query ? ' matching search' : ''}`,
  );

  const list = $('queue-list');
  list.replaceChildren();
  for (const [i, r] of rows.slice(0, shown).entries()) {
    const current = data.active?.id === r.id;
    const isWorking = current && working();
    const n = el('article', 'queue-row' + (isWorking ? ' is-active' : ''));
    n.dataset.id = r.id;

    const head = el('div', 'queue-head');
    const left = el('div', 'queue-head-left');
    left.append(el('span', 'queue-position', isWorking ? 'NOW' : `#${String(i + 1).padStart(2, '0')}`));
    if (r.provider) left.append(provider(r.provider));
    left.append(el('span', 'queue-alias', r.alias));
    const status = queueStatusFor(r, current, isWorking);
    head.append(left, pill(status.label, status.tone));
    n.append(head);

    n.append(pathBox(displayPath(r)));

    if (r.generated_title) n.append(el('div', 'queue-title', r.generated_title));

    const meta = el('div', 'queue-meta-bar');
    if (r.seconds) meta.append(el('strong', '', duration(r.seconds)));
    if (r.size_bytes) meta.append(el('span', '', bytes(r.size_bytes)));
    if (r.clips) meta.append(el('span', '', `${r.clips} clips · ${r.orientation || 'batch'}`));
    if (r.confirm_after) {
      if (r.remote_id) meta.append(el('strong', '', `#${r.remote_id}`));
      meta.append(el('span', '', `Check ${time(r.confirm_after, true)} (${ago(r.confirm_after)})`));
    } else {
      meta.append(el('span', '', `Captured ${date(r.captured_at || r.id)}`));
    }
    if (isWorking && data.active?.progress?.percent !== undefined) {
      meta.append(el('strong', '', `${data.active.progress.percent.toFixed(1)}% uploaded`));
    }
    n.append(meta);
    list.append(n);
  }
  if (!rows.length) list.append(empty(query ? 'No recordings match that search.' : 'Nothing waiting here right now.'));
  $('show-more').hidden = rows.length <= shown;
  if (anchorId) {
    const restored = [...list.children].find(n => n.dataset.id === anchorId);
    if (restored) window.scrollBy(0, restored.getBoundingClientRect().top - anchorTop);
  }
}

function renderActivity() {
  if (!data) return;
  const query = $('activity-search').value.trim().toLocaleLowerCase();
  const signature = JSON.stringify([activityFilter, query, data.activity, data.counts.converted, data.counts.submitted, data.counts.receipts_verified]);
  if (signature === activitySignature) return;
  activitySignature = signature;

  const stats = $('activity-stats');
  stats.replaceChildren();
  for (const [count, label] of [
    [data.counts.converted, 'Converted · 24h'],
    [data.counts.submitted, 'Submitted · 24h'],
    [data.counts.receipts_verified, 'Verified · 24h'],
  ]) {
    const n = el('div', 'activity-stat');
    n.append(el('strong', '', formatCount(count)), el('span', '', label));
    stats.append(n);
  }

  const annotated = data.activity.map(r => ({ row: r, meta: eventMetaFor(r) }));
  const counts = {
    all: annotated.length,
    uploads: annotated.filter(x => x.meta.group === 'uploads').length,
    processing: annotated.filter(x => x.meta.group === 'processing').length,
    issues: annotated.filter(x => x.meta.group === 'issues').length,
  };

  const controls = $('activity-filters');
  controls.replaceChildren();
  for (const [key, label] of [['all', 'All'], ['uploads', 'Uploads & Verified'], ['processing', 'Processing'], ['issues', 'Issues']]) {
    const b = el('button', key === activityFilter ? 'selected' : '');
    b.setAttribute('aria-pressed', String(key === activityFilter));
    b.append(document.createTextNode(label), el('span', 'filter-count', formatCount(counts[key])));
    b.addEventListener('click', () => { activityFilter = key; renderActivity(); });
    controls.append(b);
  }

  let items = activityFilter === 'all' ? annotated : annotated.filter(x => x.meta.group === activityFilter);
  if (query) {
    items = items.filter(({ row, meta }) => [row.source_path, row.recording, row.alias, row.provider, meta.label, row.from_state, row.to_state, row.reason]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  }

  text('activity-count', `${num.format(items.length)} recent transition${items.length === 1 ? '' : 's'}${query ? ' matching filter' : ''}`);

  const list = $('activity-list');
  list.replaceChildren();
  for (const { row: r, meta } of items) {
    const n = el('article', 'activity-row' + (meta.tone ? ' ' + meta.tone : ''));
    const head = el('div', 'activity-head');
    const left = el('div', 'activity-head-left');
    left.append(pill(meta.label, meta.tone));
    if (r.provider) left.append(provider(r.provider));
    left.append(el('span', 'activity-alias', r.alias));
    const t = el('time', '', `${time(r.at, true)} · ${ago(r.at)}`);
    t.dateTime = r.at;
    head.append(left, t);
    n.append(head);

    n.append(pathBox(displayPath(r)));

    const cleanReason = (r.reason || '').trim();
    if (cleanReason && !BOILERPLATE_REASONS.has(cleanReason.toLowerCase())) {
      n.append(el('div', 'activity-reason', cleanReason));
    } else if (r.from_state && r.to_state) {
      n.append(el('div', 'activity-transition', `${r.from_state} → ${r.to_state}`));
    }
    list.append(n);
  }
  if (!items.length) list.append(empty(query || activityFilter !== 'all' ? 'No transitions match that filter.' : 'No recent transitions.'));
}

function render(snapshot, isLive) {
  data = snapshot;
  live = isLive;
  if (snapshot.destination) $('destination').textContent = `PC → ${snapshot.destination.toUpperCase()}`;
  $('loading').hidden = true;
  $('dashboard').hidden = false;
  document.body.classList.toggle('saved-data', !isLive);

  text('overview-date', new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Tirane' }).format(new Date(snapshot.generated_at)).toUpperCase());

  const sessionBadge = $('session-badge');
  if (snapshot.authentication?.checked_at) {
    sessionBadge.hidden = false;
    sessionBadge.className = 'status-chip ' + (snapshot.authentication.confirmed ? 'ok' : 'warn');
    sessionBadge.textContent = snapshot.authentication.confirmed ? 'Session OK' : 'Session check failed';
  } else {
    sessionBadge.hidden = true;
  }

  const healthyLabels = {
    user_paused: 'Paused by you',
    paused: 'Upload worker paused',
    cooldown: 'Retry scheduled',
    upload_quota_wait: 'Waiting for allowance',
    uploads_held: 'Uploads held, converting',
    full_ahead: 'Converted ahead to the cap',
    resource_wait: 'Waiting for resources',
    status_unavailable: 'Service status unavailable',
  };
  text('health-label', !isLive ? 'Last known status' : snapshot.health.attention ? `${snapshot.health.attention} need attention` : healthyLabels[snapshot.campaign.state] || 'Running normally');
  $('health-label').classList.toggle('attention', snapshot.health.attention > 0 || snapshot.campaign.state === 'status_unavailable');

  const stats = $('summary-stats');
  stats.replaceChildren();
  for (const [value, label, onClick] of [
    [snapshot.counts.verified, 'Verified copies', () => navigate('activity')],
    [snapshot.counts.ready, 'Jobs queued', () => openQueue('next')],
    [snapshot.counts.confirming, 'Awaiting verify', () => openQueue('verify')],
    [snapshot.counts.submitted, 'Submitted · 24h', () => { activityFilter = 'uploads'; navigate('activity'); renderActivity(); }],
  ]) {
    const n = el('button', 'stat interactive');
    n.append(el('strong', '', formatCount(value)), el('span', '', label));
    n.addEventListener('click', onClick);
    stats.append(n);
  }

  const attention = $('attention');
  attention.hidden = !snapshot.health.attention;
  attention.replaceChildren();
  if (snapshot.health.attention) {
    attention.append(el('strong', '', `${snapshot.health.attention} item${snapshot.health.attention === 1 ? '' : 's'} need attention`));
    for (const alert of snapshot.health.alerts.slice(0, 4)) {
      const wrap = el('div', 'alert-item');
      if (alert.source_path || alert.recording) wrap.append(el('span', 'alert-path', alert.source_path || alert.recording));
      wrap.append(el('p', '', alert.message));
      attention.append(wrap);
    }
  }

  renderHero();
  renderStages();
  renderUpNext();
  renderBudget();
  renderCarrier();
  renderHistory();
  renderShorts();
  renderStorage();
  renderServices();
  renderQueue();
  renderActivity();
  text('snapshot-time', `${isLive ? 'Updated' : 'Saved snapshot'} ${time(snapshot.generated_at, true)} · Tirana time`);
}

function navigate(name) {
  if (!['overview', 'queue', 'activity'].includes(name)) return;
  page = name;
  for (const node of document.querySelectorAll('.page')) node.hidden = node.id !== page;
  for (const b of document.querySelectorAll('[data-page]')) {
    b.classList.toggle('selected', b.dataset.page === page);
    if (b.dataset.page === page) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  history.replaceState(null, '', '#' + page);
}

function openQueue(key) {
  filter = key;
  shown = 40;
  $('queue-search').value = '';
  renderQueue();
  navigate('queue');
}

function usable(value) {
  return value && value.counts && value.campaign && value.budget && value.health && Array.isArray(value.health.alerts)
    && value.services && value.storage && value.finalization && value.monitoring && value.shorts
    && Array.isArray(value.shorts.waiting) && Array.isArray(value.shorts.batches) && Array.isArray(value.queue)
    && Array.isArray(value.history) && Array.isArray(value.activity) && Array.isArray(value.captures)
    && Array.isArray(value.confirmations) && Array.isArray(value.budget.uplinks);
}

async function refresh(force = false) {
  if (document.hidden) return;
  if (pending && !force) return;
  if (pending) pending.abort();
  clearTimeout(timer);
  const mine = ++generation, controller = new AbortController();
  pending = controller;
  const deadline = setTimeout(() => controller.abort(), 5500);
  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store', signal: controller.signal });
    const body = await response.json();
    if (mine !== generation || document.hidden) return;
    if (!response.ok || !body.ok) {
      if (usable(body.snapshot)) render(body.snapshot, false);
      throw Error('unavailable');
    }
    if (!usable(body.snapshot)) throw Error('invalid');
    render(body.snapshot, true);
    setConnection(true);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(body.snapshot)); } catch {}
  } catch {
    if (mine !== generation || document.hidden) return;
    setConnection(false);
    if (data) render(data, false);
    else {
      $('loading').querySelector('p').textContent = 'Your PC is unreachable right now. This page will reconnect automatically.';
      $('loading').querySelector('.loading-rail').hidden = true;
    }
  } finally {
    clearTimeout(deadline);
    if (mine === generation) {
      pending = null;
      if (!document.hidden) timer = setTimeout(() => refresh(), live ? 5000 : 15000);
    }
  }
}

for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => navigate(button.dataset.page));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); navigate('overview'); });
$('refresh').addEventListener('click', () => refresh(true));
$('show-shorts').addEventListener('click', () => openQueue('shorts'));
$('show-queue').addEventListener('click', () => openQueue('next'));
$('show-more').addEventListener('click', () => { shown += 40; renderQueue(); });
$('queue-search').addEventListener('input', () => { shown = 40; renderQueue(); });
$('activity-search').addEventListener('input', () => renderActivity());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(timer); generation++; pending?.abort(); pending = null; }
  else refresh(true);
});
for (const name of ['online', 'pageshow', 'focus']) window.addEventListener(name, () => { if (!document.hidden) refresh(true); });
window.addEventListener('offline', () => setConnection(false));

try {
  const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  if (usable(saved)) {
    render(saved, false);
    setConnection(false, `Saved snapshot from ${time(saved.generated_at, true)}. Connecting to your PC…`);
  }
} catch {}
navigate(location.hash.slice(1) || 'overview');
refresh();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
