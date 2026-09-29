// Autopilot button for the Studio view — see docs/specs/server-worker-autopilot.md (part 4, v2).
// The panel never runs Claude itself: it only drops a request file. A systemd .path unit on the host
// picks it up and runs deploy/docinternal/autopilot/run.py (sandboxed container, then pipeline, then review).
const fs = require('fs');
const path = require('path');
const { PROJECT } = require('./local-pipeline');

const SLUG = /^\d\d-[a-z0-9-]+$/;
const files = (dir = path.join(PROJECT, 'production')) => ({
  request: path.join(dir, '.autopilot-request'),
  running: path.join(dir, '.autopilot-running'),
  log: path.join(dir, 'autopilot.log')
});

function request({ slug = '', topic = '', runner = '' } = {}, dir) {
  const f = files(dir);
  slug = String(slug || '').trim();
  topic = String(topic || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  runner = String(runner || '');
  if (slug && !SLUG.test(slug)) throw Object.assign(new Error('Invalid video slug'), { status: 400 });
  if (runner && !['pc', 'cloud'].includes(runner)) throw Object.assign(new Error('Invalid runner'), { status: 400 });
  if (topic.length > 200) throw Object.assign(new Error('Topic is too long (200 characters max)'), { status: 400 });
  // One JSON line per click; run.py takes the whole file and writes the scripts one after another.
  if (queued(f) >= MAX_QUEUE) throw Object.assign(new Error(`Autopilot queue is full (${MAX_QUEUE})`), { status: 409 });
  const body = { slug, topic, runner, at: new Date().toISOString() };
  fs.appendFileSync(f.request, `${JSON.stringify(body)}\n`);
  return { queued: true, ...body };
}

const MAX_QUEUE = 10;
const queued = f => (fs.existsSync(f.request) ? fs.readFileSync(f.request, 'utf8').split('\n').filter(Boolean).length : 0);

function status(dir) {
  const f = files(dir);
  const lines = fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trimEnd().split('\n') : [];
  const log = lines.slice(-30).join('\n');
  const running = fs.existsSync(f.running);
  // run.py takes the whole request file at start and logs "queue: script i of N" before each one
  const batch = running && [...lines.slice(-300).join('\n').matchAll(/queue: script (\d+) of (\d+)/g)].pop();
  return { running, requested: fs.existsSync(f.request), queued: queued(f), log,
    current: batch ? Number(batch[1]) : 0, total: batch ? Number(batch[2]) : 0 };
}

module.exports = { request, status };
