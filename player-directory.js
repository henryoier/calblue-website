/* Club identity aliases are explicit: do not merge people by similar names. */
window.CALBLUE_PLAYERS = (() => {
  const aliases = { 'qibang zhu 朱启邦': 'qibang zhu' };
  const identity = name => {
    const normalized = name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
    return aliases[normalized] || normalized;
  };
  function merge(existing, competitions) {
    const people = new Map();
    const sources = [
      { players: existing },
      ...Object.entries(competitions).sort(([a, x], [b, y]) =>
        (x.seasonStartsOn || '').localeCompare(y.seasonStartsOn || '') || a.localeCompare(b)
      ).map(([, roster]) => roster),
    ];
    for (const source of sources) {
      for (const player of source.players) {
        const id = identity(player.name);
        const previous = people.get(id) || {};
        const photos = [...new Set([player.photo, ...(previous.photos || [])].filter(Boolean))];
        people.set(id, { ...previous, ...Object.fromEntries(Object.entries(player).filter(([, value]) => value)), photos });
      }
    }
    return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  return { merge };
})();
