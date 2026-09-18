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
        // A club card marked data-pinned-photo keeps its own photo first; otherwise the newest competition photo leads.
        const pinnedPhoto = previous.pinnedPhoto || (player.pinned ? player.photo : '');
        const photos = [...new Set([pinnedPhoto, player.photo, ...(player.photos || []), ...(previous.photos || [])].filter(Boolean))];
        const merged = { ...previous, ...Object.fromEntries(Object.entries(player).filter(([, value]) => value)), photos };
        if (pinnedPhoto) { merged.pinnedPhoto = pinnedPhoto; merged.photo = pinnedPhoto; }
        delete merged.pinned;
        people.set(id, merged);
      }
    }
    return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  /* Club-supplied photos (data/player-photo-pins.json) lead wherever the player appears; league photos stay as fallbacks. */
  function applyPins(players, pins) {
    const byIdentity = new Map(Object.entries(pins || {}).map(([name, photo]) => [identity(name), photo]));
    return players.map((player) => {
      const pin = byIdentity.get(identity(player.name));
      if (!pin) return player;
      const photos = [...new Set([pin, ...(player.photos || []), player.photo].filter(Boolean))];
      return { ...player, photo: pin, photos };
    });
  }
  return { merge, applyPins, identity };
})();
