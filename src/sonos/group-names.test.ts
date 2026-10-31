import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUP_NAMES_KEY, loadGroupNames, nameOf, onGroupNamesChanged, setGroupNames, signatureOf } from './group-names';

describe('group names', () => {
  beforeEach(() => {
    setGroupNames({});
  });

  it('gives a set of speakers the same signature in any order, ignoring repeats', () => {
    expect(signatureOf(['RINCON_B', 'RINCON_A', 'RINCON_C'])).toBe(signatureOf(['RINCON_C', 'RINCON_A', 'RINCON_B', 'RINCON_A']));
  });

  it('finds a name only for exactly the named set', () => {
    setGroupNames({ [signatureOf(['RINCON_A', 'RINCON_B'])]: 'Downstairs' });
    expect(nameOf(['RINCON_B', 'RINCON_A'])).toBe('Downstairs');
    expect(nameOf(['RINCON_A'])).toBeUndefined();
    expect(nameOf(['RINCON_A', 'RINCON_B', 'RINCON_C'])).toBeUndefined();
  });

  it('reads the names from the global settings, where they are a JSON string', () => {
    loadGroupNames({ [GROUP_NAMES_KEY]: JSON.stringify({ [signatureOf(['X', 'Y'])]: 'Upstairs' }), householdId: 'Sonos_1' });
    expect(nameOf(['Y', 'X'])).toBe('Upstairs');
  });

  it('treats a missing or damaged value as no names', () => {
    setGroupNames({ [signatureOf(['X', 'Y'])]: 'Upstairs' });
    loadGroupNames({ [GROUP_NAMES_KEY]: '{not json' });
    expect(nameOf(['X', 'Y'])).toBeUndefined();
  });

  it('tells listeners only when the names actually changed', () => {
    const fn = vi.fn();
    const off = onGroupNamesChanged(fn);
    setGroupNames({ a: 'One' });
    setGroupNames({ a: 'One' });
    setGroupNames({ a: 'Two' });
    off();
    setGroupNames({});
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
