export {
  agentAvatar,
  avatarLook,
  avatarIndex,
  expandPalette,
  eyeScaleFor,
  AVATAR_COLORS,
  DARK_EYES_ABOVE,
  EYES_MIN_SIZE,
  type AgentAvatarLook,
  type AvatarLook,
  type AvatarEyes,
  type AvatarEyeType,
  type AvatarPalette,
} from "./rule.js";
export { AVATAR_SHAPES, avatarShape, type AvatarShape, type AvatarShapeName, type EyeAnchor } from "./shapes.js";
export {
  AVATAR_EXPRESSIONS,
  AVATAR_STATES,
  EMOTE_MS,
  sizeTier,
  stateExpression,
  type AvatarExpression,
  type AvatarState,
  type SizeTier,
} from "./face.js";
export { mountAvatar, type AvatarHandle, type AvatarOptions, type AvatarVariant } from "./avatar.js";
export { avatarBackground, avatarSvg, type AvatarSvgOptions } from "./fallback.js";
export {
  acquireAvatarImage,
  canBlink,
  avatarImageStats,
  clearAvatarImages,
  IDLE_IMAGE_LIMIT,
  type AvatarImage,
  type AvatarImageOptions,
} from "./image.js";
export { ENLARGED_BODY, ENLARGED_CANVAS, ERROR_FADE } from "./draw.js";
export { BLINK_SHUT_MS, MAX_BLINKING, blinkStats, startBlinking, type Blinker } from "./blink.js";
