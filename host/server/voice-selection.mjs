// Deterministic voice matching keeps Bot profile data on the Host. Voice candidates
// describe the roles and languages they suit; no extra model request is needed per call.
const text = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';

const profileFields = ['name', 'title', 'description'];

export function profileText(agent) {
  return profileFields.map(key => text(agent?.[key])).filter(Boolean).join(' ').slice(0, 5000);
}

export function profileLanguage(agent) {
  const value = profileText(agent);
  const han = (value.match(/[\p{Script=Han}]/gu) ?? []).length;
  const latin = (value.match(/[a-z]/giu) ?? []).length;
  if (han && han >= latin) return 'zh';
  return latin ? 'en' : '';
}

function includesKeyword(value, keyword) {
  if (!keyword || !value) return false;
  if (/\p{Script=Han}/u.test(keyword)) return value.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(value);
}

/** Return the best compatible candidate, or null when the default voice is safer. */
export function selectVoiceCandidate(selection, provider, agent) {
  if (selection?.enabled !== true || !Array.isArray(selection.candidates)) return null;
  const source = profileText(agent);
  if (!source) return null;
  const language = profileLanguage(agent);
  let best = null;
  for (const candidate of selection.candidates) {
    if (candidate?.provider !== provider) continue;
    const matchedKeywords = [...new Set((candidate.keywords ?? []).map(text).filter(keyword => includesKeyword(source, keyword)))];
    const languageMatch = language && (candidate.languages ?? []).some(item => text(item).split(/[-_]/)[0] === language);
    // Language breaks ties between explicit role matches. A language alone is
    // too weak an inference to replace the administrator's default voice.
    if (!matchedKeywords.length) continue;
    const score = matchedKeywords.reduce((total, keyword) => total + 20 + Math.min([...keyword].length, 20), 0)
      + (languageMatch ? 3 : 0);
    if (score && (!best || score > best.score || (score === best.score && candidate.id < best.candidate.id)))
      best = { candidate, score, language, matchedKeywords };
  }
  return best;
}
