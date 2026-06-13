'use strict';

function ensureHooksMerged(settings, additions) {
  const result = { ...settings, hooks: { ...(settings.hooks || {}) } };

  for (const { event, matcher, command } of additions) {
    const list = (result.hooks[event] || []).map((entry) => ({
      ...entry,
      hooks: [...(entry.hooks || [])],
    }));

    let entry = list.find((e) => e.matcher === matcher);
    if (!entry) {
      entry = { matcher, hooks: [] };
      list.push(entry);
    }

    if (!entry.hooks.some((h) => h.command === command)) {
      entry.hooks.push({ type: 'command', command });
    }

    result.hooks[event] = list;
  }

  return result;
}

function removeHooks(settings, removals) {
  if (!settings.hooks) return settings;

  const result = { ...settings, hooks: { ...settings.hooks } };

  for (const { event, command } of removals) {
    if (!result.hooks[event]) continue;

    const list = result.hooks[event]
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks || []).filter((h) => h.command !== command),
      }))
      .filter((entry) => entry.hooks.length > 0);

    if (list.length > 0) result.hooks[event] = list;
    else delete result.hooks[event];
  }

  if (Object.keys(result.hooks).length === 0) delete result.hooks;

  return result;
}

module.exports = { ensureHooksMerged, removeHooks };
