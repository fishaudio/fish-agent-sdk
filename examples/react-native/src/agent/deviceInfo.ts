import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import { Platform } from 'react-native';

/** The `get_device_info` client tool: what the agent sees of the caller's phone. */
export async function readDeviceInfo() {
  const [battery, network] = await Promise.all([
    Battery.getBatteryLevelAsync().catch(() => -1),
    Network.getNetworkStateAsync().catch(() => undefined),
  ]);
  return {
    os: `${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`.trim(),
    model: Device.modelName ?? 'unknown',
    battery_percent: battery >= 0 ? Math.round(battery * 100) : null,
    network: network?.type ?? 'unknown',
    online: network?.isInternetReachable ?? null,
  };
}
