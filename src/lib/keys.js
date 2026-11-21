export function exportKey(chat, mode, pair) {
  const base = chat.guildId === '@me' ? `dm:${chat.channelId}` : `ch:${chat.guildId}:${chat.channelId}`;
  if (mode !== 'pair') return base;
  const names = pair.map((n) => n.trim().replace(/^@/, '').toLowerCase()).sort();
  return `${base}:pair:${names.join('|')}`;
}

export function bookTitle(record) {
  const { chat, mode, pair } = record;
  if (mode === 'pair') return `${pair[0]} & ${pair[1]} in ${chat.title}`;
  return chat.title;
}

export function pdfFilename(record) {
  const clean = (s) => s.replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 80) || 'Discord chat';
  const where = record.chat.serverName ? ` - ${clean(record.chat.serverName)}` : '';
  return `Discord Books/${clean(bookTitle(record))}${where} [${record.chat.channelId.slice(-6)}].pdf`;
}
