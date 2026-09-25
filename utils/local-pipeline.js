// Bridge to the project's own production pipeline (../tools/pipeline.py) for the dashboard "Studio" view.
// Step logic lives in pipeline.py (also used by the autopilot); this file only calls it and turns a finished
// video into a review-queue production (needs_review) so the normal approve → publish flow uploads it.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
const PYTHON = process.env.PIPELINE_PYTHON || 'python';
const SLUG = /^\d\d-[a-z0-9-]+$/;
const STEPS = new Set(['text', 'voice', 'archive', 'ai_shots', 'music', 'align', 'render', 'thumbnail', 'all']);

function status() {
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
function run(slug, step) {
  assertSlug(slug);
  if (!STEPS.has(step)) {
    const error = new Error(`Unknown step: ${step}`);
    error.status = 400;
    throw error;
  }
  const child = spawn(PYTHON, ['tools/pipeline.py', 'run', slug, step], {
    cwd: PROJECT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  return { started: true, slug, step };
}

function log(slug, lines = 40) {
  assertSlug(slug);
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

module.exports = { status, run, log, parsePublishKit, buildProduction, PROJECT };
