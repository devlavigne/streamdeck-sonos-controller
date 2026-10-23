import streamDeck, {
    action,
    KeyAction,
    KeyDownEvent,
    SingletonAction,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import { mdiCog, mdiSpeakerMultiple } from "@mdi/js";
import { KEY_ICON, KEY_TIERS, keyActiveFrame, keyActivePlate, keyCaption, keyIcon, keyLoadingGlyph, keyStatusBadge, keySvg } from "@rocklobster42195/streamdeck-kit";
import type { SonosDevice } from "@svrooij/sonos";
import { discoveryPromise, safeDevices } from "../sonos/sonos-discovery";
import { ACCENT_COLOR } from "../utils/icons";
import { piT } from "../utils/pi-i18n";

type GroupSpeakersSettings = {
    // The speaker that leads the group: the others play whatever it plays, in sync
    deviceIp?: string;
    // The speakers that join it (the kit's <pi-multi-select>: an array of hosts)
    memberIps?: string[];
    // { host: room name } for members that are offline right now (the multi-select's label-setting)
    memberNames?: Record<string, string>;
};

type KeyState = { action: KeyAction<GroupSpeakersSettings>; settings: GroupSpeakersSettings; busy: boolean; failedUntil: number };

// Sonos groups only exist while speakers are joined; they can't be saved and played to later.
// This key forms one on demand — the members join the leader with `x-rincon:<leader uuid>`, the
// standard way Sonos joins a speaker to a group — and splits it again on the next press. Played to
// separately, two speakers are two unsynced streams; joined, the leader feeds them in sync.
@action({ UUID: "de.boriskemper.sonos-controller.group-speakers-key" })
export class GroupSpeakersKey extends SingletonAction<GroupSpeakersSettings> {
    private readonly keys = new Map<string, KeyState>();
    // Membership changes also come from the Sonos app; the library keeps each device's
    // Coordinator current from topology events, so reading it is local — no network per tick
    private poll?: NodeJS.Timeout;
    private readonly lastImage = new Map<string, string>();

    override async onWillAppear(ev: WillAppearEvent<GroupSpeakersSettings>): Promise<void> {
        if (!ev.action.isKey()) return;
        this.keys.set(ev.action.id, { action: ev.action, settings: ev.payload.settings, busy: false, failedUntil: 0 });
        this.poll ??= setInterval(() => this.renderAll(), POLL_MS);
        await discoveryPromise;
        this.render(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<GroupSpeakersSettings>): void {
        const key = this.keys.get(ev.action.id);
        if (!key) return;
        key.settings = ev.payload.settings;
        this.render(ev.action.id);
    }

    override onWillDisappear(ev: WillDisappearEvent<GroupSpeakersSettings>): void {
        this.keys.delete(ev.action.id);
        this.lastImage.delete(ev.action.id);
        if (this.keys.size === 0) {
            clearInterval(this.poll);
            this.poll = undefined;
        }
    }

    override async onKeyDown(ev: KeyDownEvent<GroupSpeakersSettings>): Promise<void> {
        const key = this.keys.get(ev.action.id);
        if (!key || key.busy) return;
        const g = resolve(ev.payload.settings);
        if (!g.leader || g.members.length === 0) {
            await ev.action.showAlert();
            return;
        }

        key.busy = true;
        this.render(ev.action.id);
        try {
            if (g.grouped) await ungroup(g.members);
            else await group(g.leader, g.members);
            streamDeck.logger.info(`[GroupSpeakers] ${g.grouped ? "ungrouped" : "grouped"} ${g.members.map((m) => m.Name).join(", ")} ${g.grouped ? "from" : "with"} ${g.leader.Name}`);
        } catch (e) {
            streamDeck.logger.error(`[GroupSpeakers] ${g.grouped ? "ungroup" : "group"} failed:`, e);
            key.failedUntil = Date.now() + FAILED_MS;
        } finally {
            key.busy = false;
            this.render(ev.action.id);
        }
    }

    private renderAll(): void {
        for (const id of this.keys.keys()) this.render(id);
    }

    /** Draws the key only when its image changed (the poll runs often). */
    private render(id: string): void {
        const key = this.keys.get(id);
        if (!key) return;
        const g = resolve(key.settings);
        const caption = captionOf(key.settings, g);
        const parts: string[] = [];
        if (!key.settings.deviceIp || !key.settings.memberIps?.length) {
            parts.push(keyIcon(mdiCog, KEY_ICON.withCaption, KEY_TIERS.unavailable), keyCaption(piT("Config..."), KEY_TIERS.unavailable));
        } else if (key.busy) {
            parts.push(keyLoadingGlyph());
        } else {
            const usable = !!g.leader && g.members.length > 0;
            const color = g.grouped ? ACCENT_COLOR : usable ? KEY_TIERS.available : KEY_TIERS.unavailable;
            if (g.grouped) parts.push(keyActivePlate(ACCENT_COLOR));
            parts.push(keyIcon(mdiSpeakerMultiple, KEY_ICON.withCaption, color), keyCaption(caption, color));
            if (g.grouped) parts.push(keyActiveFrame(ACCENT_COLOR));
            if (key.failedUntil > Date.now()) parts.push(keyStatusBadge("failed"));
        }
        const image = keySvg(parts);
        if (this.lastImage.get(id) === image) return;
        this.lastImage.set(id, image);
        void key.action.setImage(image);
    }
}

const POLL_MS = 1500;
const FAILED_MS = 4000;

/** The configured speakers as discovered right now, and whether they currently play as one group. */
function resolve(s: GroupSpeakersSettings): { leader?: SonosDevice; members: SonosDevice[]; grouped: boolean } {
    const devices = safeDevices();
    const leader = devices.find((d) => d.Host === s.deviceIp);
    const members = (s.memberIps ?? [])
        .filter((ip) => ip !== s.deviceIp)
        .map((ip) => devices.find((d) => d.Host === ip))
        .filter((d): d is SonosDevice => !!d);
    // In one group when every member follows the same coordinator as the leader (the leader may
    // itself have been joined to someone else in the Sonos app — that still counts as together)
    const head = leader ? (leader.Coordinator ?? leader).Host : undefined;
    const grouped = !!head && members.length > 0 && members.every((m) => (m.Coordinator ?? m).Host === head);
    return { leader, members, grouped };
}

/** The leader leaves any other group first, so the members join it and not whatever it was part of. */
async function group(leader: SonosDevice, members: SonosDevice[]): Promise<void> {
    if ((leader.Coordinator ?? leader).Host !== leader.Host) {
        await leader.AVTransportService.BecomeCoordinatorOfStandaloneGroup({ InstanceID: 0 });
    }
    for (const m of members) {
        await m.AVTransportService.SetAVTransportURI({ InstanceID: 0, CurrentURI: `x-rincon:${leader.Uuid}`, CurrentURIMetaData: "" });
    }
}

/** Only the members leave; the leader keeps playing. */
async function ungroup(members: SonosDevice[]): Promise<void> {
    for (const m of members) {
        if ((m.Coordinator ?? m).Host === m.Host) continue;
        await m.AVTransportService.BecomeCoordinatorOfStandaloneGroup({ InstanceID: 0 });
    }
}

/** "Den + Office PC": the leader first, then the members; stored names stand in for offline ones. */
function captionOf(s: GroupSpeakersSettings, g: ReturnType<typeof resolve>): string {
    const names = [g.leader?.Name, ...(s.memberIps ?? []).filter((ip) => ip !== s.deviceIp).map((ip) => g.members.find((m) => m.Host === ip)?.Name ?? s.memberNames?.[ip])]
        .filter((n): n is string => !!n);
    return names.length > 2 ? `${names[0]} + ${names.length - 1}` : names.join(" + ");
}
