import streamDeck, {
    action,
    KeyAction,
    KeyDownEvent,
    SingletonAction,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import { mdiCog, mdiSpeaker, mdiSpeakerMultiple } from "@mdi/js";
import { KEY_ICON, KEY_TIERS, keyActiveFrame, keyActivePlate, keyCaption, keyIcon, keyLoadingGlyph, keyStatusBadge, keySvg } from "@rocklobster42195/streamdeck-kit";
import { onGroupNamesChanged } from "../sonos/group-names";
import { deviceByHost, groupLabel, groupMembers, headOf, joinGroupOf, leaveGroup } from "../sonos/grouping";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { ACCENT_COLOR } from "../utils/icons";
import { piT } from "../utils/pi-i18n";

type SpeakerInGroupSettings = {
    // The speaker this key adds and removes
    deviceIp?: string;
    // The speaker whose group it joins
    leadIp?: string;
};

type KeyState = { action: KeyAction<SpeakerInGroupSettings>; settings: SpeakerInGroupSettings; busy: boolean; failedUntil: number };

// One key per speaker: press to join the lead speaker's group, press again to leave it; lit while
// in it. A row of these shows the whole group at a glance. On the lead's own key: lit while anyone
// has joined, and a press splits the group back into single speakers.
@action({ UUID: "de.boriskemper.sonos-controller.speaker-in-group-key" })
export class SpeakerInGroupKey extends SingletonAction<SpeakerInGroupSettings> {
    private readonly keys = new Map<string, KeyState>();
    private poll?: NodeJS.Timeout;
    private readonly lastImage = new Map<string, string>();

    constructor() {
        super();
        onGroupNamesChanged(() => this.renderAll());
    }

    override async onWillAppear(ev: WillAppearEvent<SpeakerInGroupSettings>): Promise<void> {
        if (!ev.action.isKey()) return;
        this.keys.set(ev.action.id, { action: ev.action, settings: ev.payload.settings, busy: false, failedUntil: 0 });
        this.poll ??= setInterval(() => this.renderAll(), POLL_MS);
        await discoveryPromise;
        this.render(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SpeakerInGroupSettings>): void {
        const key = this.keys.get(ev.action.id);
        if (!key) return;
        key.settings = ev.payload.settings;
        this.render(ev.action.id);
    }

    override onWillDisappear(ev: WillDisappearEvent<SpeakerInGroupSettings>): void {
        this.keys.delete(ev.action.id);
        this.lastImage.delete(ev.action.id);
        if (this.keys.size === 0) {
            clearInterval(this.poll);
            this.poll = undefined;
        }
    }

    override async onKeyDown(ev: KeyDownEvent<SpeakerInGroupSettings>): Promise<void> {
        const key = this.keys.get(ev.action.id);
        if (!key || key.busy) return;
        const st = stateOf(ev.payload.settings);
        if (!st) {
            await ev.action.showAlert();
            return;
        }

        key.busy = true;
        this.render(ev.action.id);
        try {
            if (st.isLead) {
                // Everyone else in the lead's group goes back to playing alone (the lead too, if it had joined someone)
                if (st.lit) for (const d of groupMembers(headOf(st.lead))) if (d.Host !== st.lead.Host) await leaveGroup(d);
                if (headOf(st.lead) !== st.lead.Host) await leaveGroup(st.lead);
            } else if (st.lit) {
                await leaveGroup(st.me);
            } else {
                await joinGroupOf(st.me, st.lead);
            }
            streamDeck.logger.info(`[SpeakerInGroup] ${st.me.Name}: ${st.isLead ? "split group" : st.lit ? "left" : "joined"} ${st.lead.Name}'s group`);
        } catch (e) {
            streamDeck.logger.error(`[SpeakerInGroup] ${st.me.Name} failed:`, e);
            key.failedUntil = Date.now() + FAILED_MS;
        } finally {
            key.busy = false;
            this.render(ev.action.id);
        }
    }

    private renderAll(): void {
        for (const id of this.keys.keys()) this.render(id);
    }

    private render(id: string): void {
        const key = this.keys.get(id);
        if (!key) return;
        const parts: string[] = [];
        const st = stateOf(key.settings);
        if (!key.settings.deviceIp || !key.settings.leadIp) {
            parts.push(keyIcon(mdiCog, KEY_ICON.withCaption, KEY_TIERS.unavailable), keyCaption(piT("Config..."), KEY_TIERS.unavailable));
        } else if (!st) {
            // Configured, but a speaker isn't on the network right now
            parts.push(keyIcon(mdiSpeaker, KEY_ICON.withCaption, KEY_TIERS.unavailable), keyCaption(deviceByHost(key.settings.deviceIp)?.Name ?? "…", KEY_TIERS.unavailable));
        } else if (key.busy) {
            parts.push(keyLoadingGlyph());
        } else {
            const color = st.lit ? ACCENT_COLOR : KEY_TIERS.off;
            // The lead's key names the whole group while it has company ("Downstairs", "Den + 3")
            const caption = st.isLead && st.lit ? groupLabel(headOf(st.lead)) : st.me.Name;
            if (st.lit) parts.push(keyActivePlate(ACCENT_COLOR));
            parts.push(keyIcon(st.isLead ? mdiSpeakerMultiple : mdiSpeaker, KEY_ICON.withCaption, color), keyCaption(caption, color));
            if (st.lit) parts.push(keyActiveFrame(ACCENT_COLOR));
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

/** Where this key's speaker stands relative to the lead's group; undefined while either isn't discovered. */
function stateOf(s: SpeakerInGroupSettings) {
    const me = deviceByHost(s.deviceIp);
    const lead = deviceByHost(s.leadIp);
    if (!me || !lead) return undefined;
    const isLead = me.Host === lead.Host;
    const head = headOf(lead);
    // Lead: lit while the group has anyone besides it. Member: lit while it plays in the lead's group.
    const lit = isLead ? groupMembers(head).length > 1 : headOf(me) === head;
    return { me, lead, isLead, lit };
}
