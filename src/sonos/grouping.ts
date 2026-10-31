// Forming and splitting Sonos groups from the deck, and the names people give them.
//
// Groups only exist while speakers are joined (Sonos has no saved or named groups). A speaker joins
// another's group with SetAVTransportURI `x-rincon:<coordinator uuid>` and leaves with
// BecomeCoordinatorOfStandaloneGroup. Everything here reads the library's live topology
// (`.Coordinator`, kept current by the zone-group GENA subscription) — local reads, no network.
//
// Names for groups live in group-names.ts; groupLabel and saveGroupName below use them.
import streamDeck from "@elgato/streamdeck";
import type { SonosDevice } from "@svrooij/sonos";
import { currentGroupNames, GROUP_NAMES_KEY, nameOf, setGroupNames } from "./group-names";
import { isInvisibleSatellite, patchGlobalSettings, safeDevices } from "./sonos-discovery";

export function deviceByHost(host: string | undefined): SonosDevice | undefined {
    return host ? safeDevices().find((d) => d.Host === host) : undefined;
}

/** The host of the coordinator whose group `d` is in (itself when standalone). */
export function headOf(d: SonosDevice): string {
    return (d.Coordinator ?? d).Host;
}

/** The visible speakers of the group led by `headHost` (bonded satellites left out), coordinator included. */
export function groupMembers(headHost: string): SonosDevice[] {
    return safeDevices().filter((d) => headOf(d) === headHost && !isInvisibleSatellite(d.Host));
}

/** Joins `member` to the group `target` is in (`target`'s coordinator leads). */
export async function joinGroupOf(member: SonosDevice, target: SonosDevice): Promise<void> {
    const head = target.Coordinator ?? target;
    await member.AVTransportService.SetAVTransportURI({ InstanceID: 0, CurrentURI: `x-rincon:${head.Uuid}`, CurrentURIMetaData: "" });
}

/** Takes `d` out of its group (a no-op when it already plays alone). A coordinator hands the group to another member. */
export async function leaveGroup(d: SonosDevice): Promise<void> {
    if (groupMembers(headOf(d)).length <= 1) return;
    await d.AVTransportService.BecomeCoordinatorOfStandaloneGroup({ InstanceID: 0 });
}

// ---- names (the store is group-names.ts) ------------------------------------------------------

/** "Downstairs" when that exact set is named, else "Den + 3" (or "Den" alone). */
export function groupLabel(headHost: string): string {
    const members = groupMembers(headHost);
    const head = members.find((d) => d.Host === headHost) ?? deviceByHost(headHost);
    const named = members.length > 1 ? nameOf(members.map((d) => d.Uuid)) : undefined;
    if (named) return named;
    const base = head?.Name ?? headHost;
    return members.length > 1 ? `${base} + ${members.length - 1}` : base;
}

/** Names `signature` (or removes its name with an empty one), dropping `previous` if this key named another set before. */
export async function saveGroupName(signature: string, name: string | undefined, previous?: string): Promise<void> {
    const next = currentGroupNames();
    if (previous && previous !== signature) delete next[previous];
    if (name?.trim()) next[signature] = name.trim();
    else delete next[signature];
    if (!setGroupNames(next)) return;
    await patchGlobalSettings({ [GROUP_NAMES_KEY]: Object.keys(next).length ? JSON.stringify(next) : undefined })
        .catch((e) => streamDeck.logger.warn("[grouping] saving group names failed", e));
}
