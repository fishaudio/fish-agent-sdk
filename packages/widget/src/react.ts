// React adapter: `<FishAgentWidget>` renders (and registers) the <fish-agent>
// element with camelCase props, page events as callback props, and object
// props serialized for the attribute face. Importing this entry also types the
// raw element in JSX for pages that prefer it.
//
// Plain `createElement` throughout — the package's own JSX config is preact.

import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { AgentSessionOptions, EndReason } from "@fishaudio/agent-client";
import { registerWidget, type FishAgentElement } from "./element.js";
import type { SessionTokenProvider, WidgetPosition, WidgetTextContents } from "./config.js";

/** `fish-agent:error` detail. `stage` and `recovered` come with in-call runtime errors that report them. */
export interface FishAgentWidgetErrorDetail {
  code: string;
  message: string;
  stage?: string;
  recovered?: boolean;
}

/** Attributes of the raw `<fish-agent>` element (see docs/widget.md). */
export interface FishAgentAttributes {
  "agent-id"?: string;
  "server-url"?: string;
  "user-id"?: string;
  language?: string;
  /** JSON object of `{{name}}` template values. */
  "dynamic-variables"?: string;
  "agent-name"?: string;
  greeting?: string;
  "proactive-message"?: string;
  "proactive-delay"?: string | number;
  transcript?: string | boolean;
  "text-input"?: string | boolean;
  "mic-muting"?: string | boolean;
  consent?: string | boolean;
  "consent-key"?: string;
  "consent-text"?: string;
  "terms-url"?: string;
  "privacy-url"?: string;
  position?: WidgetPosition;
  /** JSON overriding UI strings (keys of `DEFAULT_TEXTS`). */
  "text-contents"?: string;
}

type FishAgentIntrinsic = FishAgentAttributes & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref?: any;
  className?: string;
  style?: CSSProperties;
  children?: never;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "fish-agent": FishAgentIntrinsic;
    }
  }
}

// Classic (pre-17 transform) JSX resolution.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "fish-agent": FishAgentIntrinsic;
    }
  }
}

export interface FishAgentWidgetProps {
  /** Public agent id. Exactly one of `agentId` / `sessionTokenProvider` is required. */
  agentId?: string;
  /** Fetches the session token from your backend (private agents); called before every session start. */
  sessionTokenProvider?: SessionTokenProvider;
  serverUrl?: string;
  /** Your end-user identifier, stored on the session. */
  userId?: string;
  language?: string;
  dynamicVariables?: Record<string, string>;
  agentName?: string;
  greeting?: string;
  proactiveMessage?: string;
  /** Seconds before the proactive bubble shows (default 3). */
  proactiveDelay?: number;
  transcript?: boolean;
  textInput?: boolean;
  micMuting?: boolean;
  consent?: boolean;
  consentKey?: string;
  consentText?: string;
  termsUrl?: string;
  privacyUrl?: string;
  position?: WidgetPosition;
  textContents?: Partial<WidgetTextContents>;
  /** Client tools for every session — the `fish-agent:call` injection, as a prop. */
  clientTools?: AgentSessionOptions["clientTools"];
  /** Runs right before a session starts; mutate `options` to adjust anything. */
  onCall?(options: AgentSessionOptions): void;
  onConnect?(event: { sessionId: string }): void;
  onDisconnect?(event: { reason: EndReason }): void;
  onError?(event: FishAgentWidgetErrorDetail): void;
  className?: string;
  style?: CSSProperties;
}

function toggle(value: boolean | undefined): string | undefined {
  // React drops a `false` custom-element prop entirely (attribute absent =
  // widget default), so booleans go over as explicit strings.
  return value === undefined ? undefined : String(value);
}

export const FishAgentWidget = forwardRef<HTMLElement, FishAgentWidgetProps>(
  function FishAgentWidget(props, ref): ReactElement {
    const hostRef = useRef<HTMLElement | null>(null);
    useImperativeHandle(ref, () => hostRef.current as HTMLElement, []);

    // Callbacks live in a ref so listeners bind once and never go stale.
    const current = useRef(props);
    current.current = props;

    useEffect(() => {
      const host = hostRef.current;
      if (!host) {
        return;
      }
      const onCall = (event: Event) => {
        const { options } = (event as CustomEvent<{ options: AgentSessionOptions }>).detail;
        const { clientTools, onCall: callback } = current.current;
        if (clientTools) {
          options.clientTools = clientTools;
        }
        callback?.(options);
      };
      const onConnect = (event: Event) =>
        current.current.onConnect?.((event as CustomEvent<{ sessionId: string }>).detail);
      const onDisconnect = (event: Event) =>
        current.current.onDisconnect?.((event as CustomEvent<{ reason: EndReason }>).detail);
      const onError = (event: Event) =>
        current.current.onError?.((event as CustomEvent<FishAgentWidgetErrorDetail>).detail);
      host.addEventListener("fish-agent:call", onCall);
      host.addEventListener("fish-agent:connect", onConnect);
      host.addEventListener("fish-agent:disconnect", onDisconnect);
      host.addEventListener("fish-agent:error", onError);
      // After the listeners: define() upgrades and mounts synchronously, and
      // anything the widget emits during mount must already have an audience.
      registerWidget();
      return () => {
        host.removeEventListener("fish-agent:call", onCall);
        host.removeEventListener("fish-agent:connect", onConnect);
        host.removeEventListener("fish-agent:disconnect", onDisconnect);
        host.removeEventListener("fish-agent:error", onError);
      };
    }, []);

    // A function can't cross the attribute face — mirror it as an element
    // property on every render.
    useEffect(() => {
      const host = hostRef.current as FishAgentElement | null;
      if (host) {
        host.sessionTokenProvider = props.sessionTokenProvider;
      }
    });

    return createElement("fish-agent", {
      ref: hostRef,
      className: props.className,
      style: props.style,
      "agent-id": props.agentId,
      "server-url": props.serverUrl,
      "user-id": props.userId,
      language: props.language,
      "dynamic-variables": props.dynamicVariables && JSON.stringify(props.dynamicVariables),
      "agent-name": props.agentName,
      greeting: props.greeting,
      "proactive-message": props.proactiveMessage,
      "proactive-delay": props.proactiveDelay?.toString(),
      transcript: toggle(props.transcript),
      "text-input": toggle(props.textInput),
      "mic-muting": toggle(props.micMuting),
      consent: toggle(props.consent),
      "consent-key": props.consentKey,
      "consent-text": props.consentText,
      "terms-url": props.termsUrl,
      "privacy-url": props.privacyUrl,
      position: props.position,
      "text-contents": props.textContents && JSON.stringify(props.textContents),
    });
  },
);
