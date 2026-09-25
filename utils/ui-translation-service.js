const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { Logger } = require('./logger');

// Dashboard UI translation through DeepL. Every string is translated once and kept in
// dashboard/i18n/<lang>.json, which the browser also loads as a static dictionary.
const SUPPORTED = { ru: 'RU' };
const MAX_TEXTS = 100;
const MAX_TEXT_CHARS = 5000;
const MAX_REQUEST_CHARS = 30000;
const DEEPL_BATCH = 50;

class UITranslationService {
  constructor(options = {}) {
    this.logger = new Logger('UITranslation');
    this.apiKey = options.apiKey ?? process.env.DEEPL_API_KEY ?? '';
    this.dir = options.dir || path.join(__dirname, '..', 'dashboard', 'i18n');
    this.http = options.http || axios;
    this.dicts = {};
    this.writeChain = Promise.resolve();
  }

  get enabled() { return Boolean(this.apiKey); }

  endpoint() {
    return this.apiKey.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
  }

  async dictionary(lang) {
    if (!this.dicts[lang]) {
      try {
        this.dicts[lang] = JSON.parse(await fs.readFile(path.join(this.dir, `${lang}.json`), 'utf8'));
      } catch (_error) {
        this.dicts[lang] = {};
      }
    }
    return this.dicts[lang];
  }

  validate(lang, texts) {
    if (!SUPPORTED[lang]) return 'Unsupported language';
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS) return `texts must be an array of 1-${MAX_TEXTS} strings`;
    if (texts.some(text => typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS)) return `each text must be a non-empty string up to ${MAX_TEXT_CHARS} chars`;
    if (texts.reduce((sum, text) => sum + text.length, 0) > MAX_REQUEST_CHARS) return 'request too large';
    return null;
  }

  async translate(lang, texts) {
    const dict = await this.dictionary(lang);
    const missing = [...new Set(texts.filter(text => !(text in dict)))];
    if (missing.length && this.enabled) {
      for (let i = 0; i < missing.length; i += DEEPL_BATCH) {
        const batch = missing.slice(i, i + DEEPL_BATCH);
        const response = await this.http.post(this.endpoint(), {
          text: batch, source_lang: 'EN', target_lang: SUPPORTED[lang], preserve_formatting: true,
          // Not billed; steers terms: production = video, generation = AI generation, thumbnail = cover.
          context: 'UI labels of a dashboard that produces YouTube videos with AI: pipeline, scripts, narration, thumbnails (video covers), generation jobs, publishing schedule, analytics.'
        }, { headers: { Authorization: `DeepL-Auth-Key ${this.apiKey}` }, timeout: 30000 });
        response.data.translations.forEach((item, index) => { dict[batch[index]] = item.text; });
      }
      await this.save(lang);
    }
    return Object.fromEntries(texts.filter(text => text in dict).map(text => [text, dict[text]]));
  }

  save(lang) {
    // Serialize writes so concurrent requests never interleave the JSON file.
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const sorted = Object.fromEntries(Object.entries(this.dicts[lang]).sort(([a], [b]) => a.localeCompare(b)));
      await fs.writeFile(path.join(this.dir, `${lang}.json`), JSON.stringify(sorted, null, 1) + '\n', 'utf8');
    }).catch(error => this.logger.error('Failed to save translations:', error.message));
    return this.writeChain;
  }
}

module.exports = { UITranslationService };
