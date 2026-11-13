import type { SessionLanguage } from '@fishaudio/agent-protocol';
import { FishAgentWidget } from '@fishaudio/agent-widget-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { requestSessionToken, type CallSource } from './agent/createSession';

const PRODUCTS = [
  { name: '无线降噪耳机', price: '¥899' },
  { name: '机械键盘', price: '¥459' },
  { name: '4K 显示器', price: '¥2,199' },
  { name: '移动电源 20000mAh', price: '¥159' },
  { name: '智能手表', price: '¥1,299' },
  { name: '蓝牙音箱', price: '¥329' },
];

/**
 * The drop-in widget over an ordinary app screen: one component, no call UI
 * of our own. The same two ways to connect as the home screen.
 */
export function WidgetDemo({
  source,
  language,
  onBack,
}: {
  source: CallSource;
  language?: SessionLanguage;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}>
        <View style={styles.bar}>
          <Text style={styles.title}>小鱼商城</Text>
          <Pressable onPress={onBack} hitSlop={10}>
            <Text style={styles.back}>返回</Text>
          </Pressable>
        </View>
        <Text style={styles.subtitle}>挂件演示：右下角的按钮就是 FishAgentWidget</Text>
        {PRODUCTS.map((p) => (
          <View key={p.name} style={styles.card}>
            <View style={styles.thumb} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.price}>{p.price}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      <FishAgentWidget
        {...(source.kind === 'backend'
          ? { sessionTokenProvider: () => requestSessionToken({ tokenUrl: source.tokenUrl, language }) }
          : { agentId: source.agentId, origin: source.origin, language })}
        agentName="小鱼客服"
        greeting="你好！有什么可以帮你？"
        proactiveMessage="需要帮忙挑选吗？"
        consent
        insets={insets}
        callNotification={{ title: '小鱼客服通话中', text: '点按返回 App' }}
        clientTools={{
          get_current_page: () => ({ page: 'product_list', products: PRODUCTS.map((p) => p.name) }),
        }}
        onError={(e) => console.warn('[widget]', e.code, e.message)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f6f5f3' },
  content: { padding: 16, paddingBottom: 120, gap: 12 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 22, fontWeight: '700', color: '#141414' },
  back: { fontSize: 15, color: '#2563eb' },
  subtitle: { fontSize: 13, color: '#8a8a86', marginBottom: 4 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 14, padding: 12 },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: '#ebeae8' },
  name: { fontSize: 15, color: '#141414', fontWeight: '500' },
  price: { fontSize: 14, color: '#e5484d', marginTop: 4 },
});
