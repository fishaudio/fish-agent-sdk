import {
  ConnectionState,
  createLocalAudioTrack,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type LocalAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import {
  AGENT_EVENT_TOPIC,
  CLIENT_EVENT_TOPIC,
  type AgentSessionMessage,
  type ClientSessionMessage,
  type SessionToken,
} from "@fishaudio/agent-protocol";
import { FishAgentError } from "../errors.js";
import type { Transport, TransportCallbacks, TransportConnectOptions } from "./types.js";

function hasMessageType(value: unknown): value is { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function captureMicrophone(inputDeviceId?: string): Promise<LocalAudioTrack> {
  return createLocalAudioTrack({
    deviceId: inputDeviceId,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
}

/** Sole production Transport. LiveKit vocabulary must not escape this file,
 * except the `Room` handed out through the `getRoom()` escape hatch. */
export class LiveKitTransport implements Transport {
  private room?: Room;
  private callbacks?: TransportCallbacks;
  private pendingMicTrack?: Promise<LocalAudioTrack>;

  prepareMicrophone(options: { inputDeviceId?: string }): void {
    const pending = captureMicrophone(options.inputDeviceId);
    // A denial surfaces where connect() awaits the track, never as an
    // unhandled rejection here.
    pending.catch(() => undefined);
    this.pendingMicTrack = pending;
  }

  async connect(sessionToken: SessionToken, options: TransportConnectOptions): Promise<void> {
    this.callbacks = options.callbacks;
    const room = new Room({
      audioCaptureDefaults: {
        deviceId: options.inputDeviceId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.room = room;

    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== AGENT_EVENT_TOPIC) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (hasMessageType(message)) {
        this.callbacks?.onAgentEvent(message as AgentSessionMessage);
      }
    });

    const AGENT_STATE_ATTRIBUTE = "lk.agent.state";
    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      const state = changed[AGENT_STATE_ATTRIBUTE];
      if (!participant.isLocal && state) {
        this.callbacks?.onAgentState(state);
      }
    });

    // The agent publishes its speech as a microphone-source track and extras such
    // as background ambience as separate tracks; every one of them plays.
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => {
      if (track.kind === Track.Kind.Audio && track.mediaStreamTrack) {
        this.callbacks?.onOutputStream(
          publication.trackSid,
          new MediaStream([track.mediaStreamTrack]),
          track.source === Track.Source.Microphone,
        );
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => {
      if (track.kind === Track.Kind.Audio) {
        this.callbacks?.onOutputStreamEnded(publication.trackSid);
      }
    });

    // Both sides' transcripts ride LiveKit's built-in transcription streams:
    // agent segments are playout-synced delta streams (final on stream close —
    // an interrupted segment closes containing only the spoken text); user STT
    // segments are re-published per update with an explicit final attribute,
    // sent on behalf of the user, so sender identity distinguishes the roles.
    room.registerTextStreamHandler("lk.transcription", async (reader, participantInfo) => {
      const attributes = reader.info.attributes ?? {};
      const segmentId = attributes["lk.segment_id"];
      if (!segmentId) {
        return;
      }
      const role =
        participantInfo.identity === room.localParticipant.identity ? "user" : "agent";
      const finalAttribute = attributes["lk.transcription_final"] === "true";
      let text = "";
      let aborted = false;
      try {
        for await (const delta of reader) {
          text += delta;
          this.callbacks?.onTranscription({ segmentId, role, text, final: false });
        }
      } catch {
        aborted = true; // interrupted mid-stream; what arrived is what was spoken
      }
      if (text) {
        const final = role === "agent" ? true : finalAttribute && !aborted;
        this.callbacks?.onTranscription({ segmentId, role, text, final });
      }
    });

    room.on(RoomEvent.Reconnecting, () => {
      this.callbacks?.onConnectionState("reconnecting");
    });
    room.on(RoomEvent.Reconnected, () => {
      // A full reconnect replays the roster from the join response before this
      // event; an agent still missing here hung up while we were away.
      if (room.remoteParticipants.size === 0) {
        this.handleAgentLeft(room);
        return;
      }
      this.callbacks?.onConnectionState("connected");
    });
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      this.callbacks?.onConnectionState(
        "disconnected",
        reason === undefined ? undefined : DisconnectReason[reason],
      );
      // Remote-initiated ends never go through disconnect(); drop the refs here
      // so getRoom() honors its ended-means-undefined contract and the room
      // can be collected.
      if (this.room === room) {
        this.room = undefined;
        this.callbacks = undefined;
      }
    });
    // An agent-side hangup ends the worker without closing the room; the
    // agent participant leaving IS the end-of-call signal for the client.
    // A full reconnect also clears the roster this way, and can do so while
    // room.state still reads Connected (Reconnecting is only set right after),
    // so defer one microtask and require a room that is genuinely connected.
    room.on(RoomEvent.ParticipantDisconnected, () => {
      if (room.remoteParticipants.size === 0) {
        queueMicrotask(() => {
          if (room.state === ConnectionState.Connected && room.remoteParticipants.size === 0) {
            this.handleAgentLeft(room);
          }
        });
      }
    });

    let micTrack: LocalAudioTrack | undefined;
    if (options.microphone !== false) {
      // Usually settled long before this point: the capture starts inside the
      // user gesture (prepareMicrophone). Awaited before joining the room so a
      // denial fails the start without ever dispatching an agent. The promise
      // stays in pendingMicTrack until the room owns the track, so disconnect()
      // can release it after any failure in between.
      const pending = this.pendingMicTrack ?? captureMicrophone(options.inputDeviceId);
      this.pendingMicTrack = pending;
      micTrack = await pending;
    }

    try {
      await room.connect(sessionToken.livekit_url, sessionToken.token);
    } catch (cause) {
      throw new FishAgentError("connection_failed", "Could not establish the realtime session", {
        cause,
      });
    }
    // The attribute is sticky: if the agent joined and set its state before us,
    // no change event will fire — replay the current value once.
    for (const participant of room.remoteParticipants.values()) {
      const state = participant.attributes?.[AGENT_STATE_ATTRIBUTE];
      if (state) {
        this.callbacks?.onAgentState(state);
      }
    }
    if (micTrack) {
      await room.localParticipant.publishTrack(micTrack);
      this.pendingMicTrack = undefined;
      this.publishInputStream();
    }
  }

  private handleAgentLeft(room: Room): void {
    this.callbacks?.onConnectionState("disconnected", "AGENT_LEFT");
    void room.disconnect();
  }

  async disconnect(): Promise<void> {
    // A capture the room never took ownership of (start failed between the
    // gesture-time capture and publish) is invisible to room.disconnect().
    const pendingMic = this.pendingMicTrack;
    this.pendingMicTrack = undefined;
    void pendingMic?.then((track) => track.stop()).catch(() => undefined);
    const room = this.room;
    this.room = undefined;
    this.callbacks = undefined;
    await room?.disconnect();
  }

  getRoom(): Room | undefined {
    return this.room;
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(enabled);
    if (enabled) {
      // After a mic-less connect the first enable captures the track late;
      // re-wiring an already-published track is a harmless replace.
      this.publishInputStream();
    }
  }

  async setInputDevice(deviceId: string): Promise<void> {
    const room = this.room;
    if (!room) {
      return;
    }
    const previous = room.getActiveDevice("audioinput");
    let switched: boolean;
    try {
      // exact: a wrong id must fail loudly, not silently fall back to another mic.
      switched = await room.switchActiveDevice("audioinput", deviceId, true);
    } catch (error) {
      // livekit stops the current track before acquiring the new device, so a
      // failed pick would otherwise leave the call silently mic-dead — switch
      // back before surfacing the failure. livekit reports "default" until the
      // real captured id is known; that pseudo-id only resolves on Chrome, so
      // restore it non-exactly and let other browsers fall back to any mic.
      if (previous !== undefined) {
        await room
          .switchActiveDevice("audioinput", previous, previous !== "default")
          .catch(() => undefined);
        this.publishInputStream();
      }
      throw error;
    }
    if (!switched) {
      throw new FishAgentError(
        "device_change_failed",
        "Could not activate the requested microphone",
      );
    }
    // A live switch replaces the publication's MediaStreamTrack — re-wire
    // analysis. While muted, livekit defers the swap to the next unmute and
    // setMicEnabled re-wires then.
    this.publishInputStream();
  }

  /** Local tracks already wired to re-emit their stream when livekit restarts them. */
  private readonly restartWiredTracks = new WeakSet<object>();

  private publishInputStream(): void {
    const room = this.room;
    if (!room) {
      return;
    }
    for (const publication of room.localParticipant.audioTrackPublications.values()) {
      const track = publication.track;
      if (track && !this.restartWiredTracks.has(track)) {
        this.restartWiredTracks.add(track);
        // Restarts replace the MediaStreamTrack without any Room-level event —
        // livekit's devicechange auto-recovery and getRoom() escape-hatch
        // switches would otherwise leave input analysis on a dead track.
        track.on(TrackEvent.Restarted, () => this.publishInputStream());
      }
      const mediaStreamTrack = track?.mediaStreamTrack;
      if (mediaStreamTrack) {
        this.callbacks?.onInputStream(new MediaStream([mediaStreamTrack]));
      }
    }
  }

  async sendClientEvent(message: ClientSessionMessage): Promise<void> {
    if (!this.room) {
      throw new FishAgentError("connection_failed", "Session is not connected");
    }
    const payload = new TextEncoder().encode(JSON.stringify(message));
    await this.room.localParticipant.publishData(payload, {
      reliable: true,
      topic: CLIENT_EVENT_TOPIC,
    });
  }
}
