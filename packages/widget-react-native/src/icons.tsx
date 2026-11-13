/*!
 * Icon path data from lucide (https://lucide.dev), used under the ISC license.
 * See THIRD-PARTY-NOTICES.txt in this package for the full notice.
 */
import type { ReactNode } from "react";
import Svg, { Line, Path, Polyline } from "react-native-svg";

interface IconProps {
  size?: number;
  color: string;
}

function icon(children: ReactNode) {
  return function Icon({ size = 16, color }: IconProps) {
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </Svg>
    );
  };
}

export const IconAudioLines = icon(
  <>
    <Path d="M2 10v3" />
    <Path d="M6 6v11" />
    <Path d="M10 3v18" />
    <Path d="M14 8v7" />
    <Path d="M18 5v13" />
    <Path d="M22 10v3" />
  </>,
);

export const IconX = icon(
  <>
    <Path d="M18 6 6 18" />
    <Path d="m6 6 12 12" />
  </>,
);

export const IconMinimize = icon(
  <>
    <Polyline points="4 14 10 14 10 20" />
    <Polyline points="20 10 14 10 14 4" />
    <Line x1="14" x2="21" y1="10" y2="3" />
    <Line x1="3" x2="10" y1="21" y2="14" />
  </>,
);

export const IconSend = icon(
  <>
    <Path d="m22 2-7 20-4-9-9-4Z" />
    <Path d="M22 2 11 13" />
  </>,
);

export const IconMic = icon(
  <>
    <Path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <Line x1="12" x2="12" y1="19" y2="22" />
  </>,
);

export const IconMicOff = icon(
  <>
    <Path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <Line x1="12" x2="12" y1="19" y2="22" />
    <Line x1="3" x2="21" y1="3" y2="21" />
  </>,
);

export const IconPhone = icon(
  <Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />,
);

export const IconPhoneOff = icon(
  <>
    <Path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
    <Line x1="22" x2="2" y1="2" y2="22" />
  </>,
);

export const IconChevronDown = icon(<Path d="m6 9 6 6 6-6" />);
