// Names people give a set of speakers ("Downstairs"): whenever exactly that set plays as one
// group, the places that show the group use the name instead of "Den + 3". Keyed by the speakers'
// Sonos UUIDs (stable; IPs come from DHCP), kept in the plugin's global settings so a name is known
// even while the key that set it is on another page.
//
// No discovery import here on purpose — soc-players.ts uses this and must not start discovery
// (see its membersOf comment); the writer, which needs discovery's merging global-settings patch,
// is saveGroupName in grouping.ts.
import streamDeck from "@elgato/streamdeck";

export const GROUP_NAMES_KEY = "groupNames";

let names: Record<string, string> = {};
const listeners = new Set<() => void>();

/** One id for a set of speakers, whatever order they were picked in. */
export function signatureOf(uuids: string[]): string {
    return [...new Set(uuids)].sort().join(",");
}

/** The name given to exactly this set of speakers, if any. */
export function nameOf(uuids: string[]): string | undefined {
    return names[signatureOf(uuids)];
}

export function currentGroupNames(): Record<string, string> {
    return { ...names };
}

/** Called when a name was added, changed or removed; returns the unsubscribe. */
export function onGroupNamesChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Replaces the names; tells the listeners when anything changed. Returns whether it did. */
export function setGroupNames(next: Record<string, string>): boolean {
    if (JSON.stringify(next) === JSON.stringify(names)) return false;
    names = next;
    listeners.forEach((fn) => fn());
    return true;
}

/** Reads the names out of the global settings (stored as a JSON string: global settings hold strings). */
export function loadGroupNames(settings: Record<string, unknown>): void {
    const raw = settings[GROUP_NAMES_KEY];
    let next: Record<string, string> = {};
    if (typeof raw === "string") {
        try {
            next = JSON.parse(raw) as Record<string, string>;
        } catch { /* a damaged value counts as none */ }
    }
    setGroupNames(next);
}

/** Call once at start: loads the names and follows later changes. */
export function initGroupNames(): void {
    streamDeck.settings.onDidReceiveGlobalSettings((ev) => loadGroupNames(ev.settings as Record<string, unknown>));
    void streamDeck.settings.getGlobalSettings().then((s) => loadGroupNames(s as Record<string, unknown>)).catch(() => undefined);
}
