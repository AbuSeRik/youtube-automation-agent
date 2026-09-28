// Posting Hub hand-off (2026-09-28): the Hub owns publish dates and uploads to YouTube.
// "Approve" here writes a package folder into the Hub inbox; the folder appears atomically
// (.tmp-<id> then rename), so the Hub never reads a half-written package.
const fs = require('fs/promises');
const path = require('path');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

function hubInbox() {
  return process.env.HUB_INBOX || '';
}

function packageId(productionId) {
  return `cf-${String(productionId).replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 100);
}

async function exportToHub(inbox, p) {
  const id = packageId(p.productionId);
  const final = path.join(inbox, id);
  if (await fs.stat(final).then(() => true, () => false)) return { packageId: id, existed: true };
  const tmp = path.join(inbox, `.tmp-${id}`);
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(path.join(tmp, 'media'), { recursive: true });
  const videoName = `video${path.extname(p.videoPath).toLowerCase() || '.mp4'}`;
  await fs.copyFile(p.videoPath, path.join(tmp, 'media', videoName));
  const pkg = {
    package_id: id,
    factory: 'closed-forever',
    factory_ref: String(p.productionId),
    account: process.env.HUB_ACCOUNT || 'youtube:closedforeverusa',
    content_type: 'video',
    media: [`media/${videoName}`],
    title: String(p.title || '').trim().slice(0, 100),
    description: String(p.description || '').slice(0, 5000),
    tags: (Array.isArray(p.tags) ? p.tags : []).map(String).slice(0, 30),
    category_id: String(p.categoryId || '19'),
    privacy: p.privacy || 'public',
    made_for_kids: false,
    ai_generated: p.synthetic === true,
    created_at: new Date().toISOString()
  };
  const thumbExt = p.thumbnailPath ? path.extname(p.thumbnailPath).toLowerCase() : '';
  if (IMAGE_EXT.includes(thumbExt)) {
    await fs.copyFile(p.thumbnailPath, path.join(tmp, 'media', `thumb${thumbExt}`));
    pkg.thumbnail = `media/thumb${thumbExt}`;
  }
  await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2));
  await fs.rename(tmp, final);
  return { packageId: id, existed: false };
}

module.exports = { exportToHub, hubInbox, packageId };
