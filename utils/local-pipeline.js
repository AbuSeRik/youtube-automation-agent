// Bridge to the project's own production pipeline (../tools/pipeline.py) for the dashboard "Studio" view.
// Step logic lives in pipeline.py (also used by the autopilot); this file only calls it and turns a finished
// video into a review-queue production (needs_review) so the normal approve → publish flow uploads it.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT = path.resolve(process.env.STUDIO_PROJECT || path.join(__dirname, '..', '..'));
const PYTHON = process.env.PIPELINE_PYTHON || 'python';
const SLUG = /^\d\d-[a-z0-9-]+$/;
const STEPS = new Set(['text', 'voice', 'archive', 'ai_shots', 'music', 'align', 'render', 'thumbnail', 'all']);

// Server mode (DocInternal): steps run on the GPU worker (tools/worker/worker.py) over Tailscale.
const WORKER_URL = process.env.WORKER_URL || '';
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
// creative inputs written here (by Claude) → pushed to the worker before a step runs; worker name → local path
const INPUTS = {
  'shots.json': slug => path.join(PROJECT, 'production', slug, 'shots.json'),
  'images/archive-list.txt': slug => path.join(PROJECT, 'production', slug, 'images', 'archive-list.txt'),
  'edit.json': slug => path.join(PROJECT, 'production', slug, 'edit.json'),
  'music/caption.txt': slug => path.join(PROJECT, 'production', slug, 'music', 'caption.txt'),
  'publish/thumbnail.json': slug => path.join(PROJECT, 'production', slug, 'publish', 'thumbnail.json'),
  'script.md': slug => path.join(PROJECT, 'scripts', `${slug}.md`),
  'publish.md': slug => path.join(PROJECT, 'publish', `${slug}.md`)
};
// finished outputs pulled from the worker before submit (needed by the YouTube upload)
const OUTPUTS = ['edit/draft.mp4', 'publish/thumbnail.jpg', 'edit/narration.srt', 'voice/narration.mp3', 'voice/narration.txt'];

async function worker(method, route, body) {
  const response = await fetch(`${WORKER_URL}${route}`, {
    method,
    headers: { Authorization: `Bearer ${WORKER_TOKEN}`, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}) },
    body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(method === 'GET' && route.startsWith('/file/') ? 600000 : 30000)
  });
  if (!response.ok) throw Object.assign(new Error(`worker ${route}: HTTP ${response.status}`), { status: 502 });
  return response;
}

async function pushInputs(slug) {
  for (const [name, local] of Object.entries(INPUTS)) {
    const file = local(slug);
    if (fs.existsSync(file)) await worker('PUT', `/file/${slug}/${name}`, fs.readFileSync(file));
  }
}

async function pullOutputs(slug) {
  if (!WORKER_URL) return;
  for (const name of OUTPUTS) {
    const target = path.join(PROJECT, 'production', slug, name);
    const data = Buffer.from(await (await worker('GET', `/file/${slug}/${name}`)).arrayBuffer());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

async function status() {
  if (WORKER_URL) {
    const videos = await (await worker('GET', '/status')).json();
    for (const v of videos) {  // uploads happen on the server, so its publish/youtube.json marker wins
      const marker = path.join(PROJECT, 'production', v.slug, 'publish', 'youtube.json');
      if (fs.existsSync(marker)) v.youtube = JSON.parse(fs.readFileSync(marker, 'utf8'));
    }
    return videos;
  }
  return new Promise((resolve, reject) => {
    execFile(PYTHON, ['tools/pipeline.py', 'status', '--json'], { cwd: PROJECT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 4 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))));
  });
}

function assertSlug(slug) {
  if (!SLUG.test(slug) || !fs.existsSync(path.join(PROJECT, 'scripts', `${slug}.md`))) {
    const error = new Error(`Unknown video: ${slug}`);
    error.status = 404;
    throw error;
  }
}

// Fire-and-forget: pipeline.py journals the run and holds the single-GPU lock itself.
async function run(slug, step) {
  assertSlug(slug);
  if (!STEPS.has(step)) {
    const error = new Error(`Unknown step: ${step}`);
    error.status = 400;
    throw error;
  }
  if (WORKER_URL) {
    await pushInputs(slug);
    return (await worker('POST', '/run', { slug, step })).json();
  }
  const child = spawn(PYTHON, ['tools/pipeline.py', 'run', slug, step], {
    cwd: PROJECT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  return { started: true, slug, step };
}

async function log(slug, lines = 40) {
  assertSlug(slug);
  if (WORKER_URL) return (await worker('GET', `/log/${slug}`)).json();
  const dir = path.join(PROJECT, 'production', slug, 'logs');
  if (!fs.existsSync(dir)) return { step: null, text: '' };
  const latest = fs.readdirSync(dir).filter(f => f.endsWith('.log'))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  if (!latest) return { step: null, text: '' };
  // tqdm-style progress lines use \r — keep only the last state of each line
  const text = fs.readFileSync(path.join(dir, latest.f), 'utf8').split('\n').map(l => l.split('\r').pop());
  return { step: latest.f.replace(/\.log$/, ''), text: text.slice(-lines).join('\n') };
}

// publish/<slug>.md sections: "## Title", "## Description", "## Tags" (comma-separated line)
function parsePublishKit(markdown) {
  const sections = {};
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { current = heading[1].toLowerCase(); sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const text = name => (sections[name] || []).join('\n').trim();
  const title = text('title').split('\n')[0].trim();
  const tags = text('tags').replace(/`/g, '').split(',').map(t => t.trim()).filter(Boolean);
  if (!title || !text('description')) throw Object.assign(new Error('publish kit needs "## Title" and "## Description"'), { status: 422 });
  return { title, description: text('description'), tags };
}

function buildProduction(slug) {
  assertSlug(slug);
  const dir = path.join(PROJECT, 'production', slug);
  const file = rel => path.join(dir, rel);
  const kitPath = path.join(PROJECT, 'publish', `${slug}.md`);
  const required = { 'edit/draft.mp4': 'монтаж', 'publish/thumbnail.jpg': 'обложка', 'voice/narration.mp3': 'голос', 'edit/narration.srt': 'разметка' };
  const missing = Object.entries(required).filter(([rel]) => !fs.existsSync(file(rel))).map(([, label]) => label);
  if (!fs.existsSync(kitPath)) missing.push(`publish/${slug}.md`);
  if (fs.existsSync(file('publish/youtube.json'))) throw Object.assign(new Error('Already published (publish/youtube.json)'), { status: 409 });
  if (missing.length) throw Object.assign(new Error(`Not ready: ${missing.join(', ')}`), { status: 409 });

  const kit = parsePublishKit(fs.readFileSync(kitPath, 'utf8'));
  const narration = fs.existsSync(file('voice/narration.txt')) ? fs.readFileSync(file('voice/narration.txt'), 'utf8') : '';
  return {
    id: `studio-${slug}-${Date.now()}`,
    status: 'needs_review',
    assets: {
      finalVideo: { path: file('edit/draft.mp4') },
      thumbnail: { path: file('publish/thumbnail.jpg') },
      captions: { path: file('edit/narration.srt') },
      audio: { path: file('voice/narration.mp3') }
    },
    timeline: { source: 'studio', slug },
    scheduledPublishTime: null,
    priority: 50,
    strategy: { topic: kit.title, source: 'studio' },
    script: { title: kit.title, fullScript: narration },
    thumbnail: { path: file('publish/thumbnail.jpg') },
    seo: { title: kit.title, description: kit.description, tags: kit.tags, categoryId: '19', defaultLanguage: 'en' },
    containsSyntheticMedia: true // our videos use AI stills; the channel always discloses (decision 2026-09-25)
  };
}

module.exports = { status, run, log, pullOutputs, parsePublishKit, buildProduction, PROJECT };
