import { Button, Host, List, RNHostView, Text as SwiftUIText, VStack } from '@expo/ui/swift-ui';
import { buttonStyle } from '@expo/ui/swift-ui/modifiers';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button as RNButton, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Item = { id: string; expanded: boolean };
const data: Item[] = Array.from({ length: 200 }, (_, index) => ({
  id: String(index),
  expanded: false,
}));
const keyExtractor = (item: Item) => item.id;
let mountedCount = 0;

function Row({ id, expanded, onToggle }: Item & { onToggle: (id: string) => void }) {
  const [taps, setTaps] = useState(0);
  useEffect(() => {
    if (!__DEV__) return;
    mountedCount++;
    console.info(`[List window] mount ${id}; count=${mountedCount}`);
    return () => {
      mountedCount--;
      console.info(`[List window] unmount ${id}; count=${mountedCount}`);
    };
  }, [id]);
  return (
    <VStack alignment="leading" spacing={8}>
      <Button
        label={`Row ${id} · taps ${taps}`}
        onPress={() => setTaps((value) => value + 1)}
        // Keep this button's action separate from the embedded RN Pressable.
        modifiers={[buttonStyle('borderless')]}
      />
      <SwiftUIText>{'Variable height content. '.repeat(((Number(id) % 5) + 1) * 3)}</SwiftUIText>
      <RNHostView matchContents>
        {/* matchContents sizes both axes from RN; bound the width so text can wrap. */}
        <View
          style={{
            maxWidth: 280,
            padding: 12,
            gap: 8,
            backgroundColor: '#e8f2ff',
            borderRadius: 8,
          }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            testID={`expand-row-${id}`}
            onPress={() => onToggle(id)}
            style={{ paddingVertical: 8 }}>
            <Text style={{ color: '#005bbb', fontSize: 16 }}>
              {`${expanded ? 'Collapse' : 'Expand'} RN content ${id}`}
            </Text>
          </Pressable>
          {expanded && (
            <Text testID={`details-row-${id}`} style={{ color: '#18212b', fontSize: 16 }}>
              {`Details for row ${id}. ` +
                'This React Native text determines its own height. '.repeat(8)}
            </Text>
          )}
        </View>
      </RNHostView>
    </VStack>
  );
}

export default function Playground() {
  const [pagination, setPagination] = useState(false);
  return pagination ? (
    <PaginationExample onBack={() => setPagination(false)} />
  ) : (
    <HardeningExample onPagination={() => setPagination(true)} />
  );
}

function PaginationExample({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState(() => data.slice(0, 5));
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hasMore = items.length < 15;
  useEffect(() => () => clearTimeout(pending.current), []);
  const loadMore = useCallback(() => {
    if (pending.current !== undefined || !hasMore) return;
    setLoading(true);
    setRequests((value) => value + 1);
    // Simulated page fetch; real apps should also surface errors and a retry action.
    pending.current = setTimeout(() => {
      setItems((current) => [...current, ...data.slice(current.length, current.length + 5)]);
      pending.current = undefined;
      setLoading(false);
    }, 600);
  }, [hasMore]);
  const toggle = useCallback((id: string) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, expanded: !item.expanded } : item))
    );
  }, []);
  const renderItem = useCallback(
    ({ item }: { item: Item }) => <Row {...item} onToggle={toggle} />,
    [toggle]
  );
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      <View style={{ padding: 16 }}>
        <RNButton title="Back to hardening" onPress={onBack} />
        <Text>List append pagination</Text>
        <Text testID="pagination-status">
          {`${items.length} rows · ${requests} requests · ${loading ? 'Loading' : hasMore ? 'More available' : 'All loaded'}`}
        </Text>
      </View>
      <Host style={{ flex: 1 }}>
        <List
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedRowHeight={100}
          initialNumToRender={0}
          overscanCount={5}
          onEndReached={hasMore ? loadMore : undefined}
          onEndReachedItemThreshold={2}
        />
      </Host>
    </SafeAreaView>
  );
}

function HardeningExample({ onPagination }: { onPagination: () => void }) {
  const [generation, setGeneration] = useState(0);
  const [items, setItems] = useState(data);
  const [stress, setStress] = useState(false);
  const [step, setStep] = useState(0);
  const nextId = useRef(200);
  const toggleExpanded = useCallback((id: string) => {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index < 0) return current;
      // An immutable data edit on a tap, never a dataset copy during scrolling.
      const next = current.slice();
      next[index] = { ...current[index]!, expanded: !current[index]!.expanded };
      return next;
    });
  }, []);
  const renderItem = useCallback(
    ({ item }: { item: Item }) => <Row {...item} onToggle={toggleExpanded} />,
    [toggleExpanded]
  );

  useEffect(() => {
    if (!stress) return;
    let tick = 0;
    // Mutations happen independently of gestures, so a fling can overlap native data commits.
    const timer = setInterval(() => {
      tick++;
      const id = String(nextId.current++);
      setItems((current) => {
        switch (tick % 5) {
          case 1:
            return [{ id, expanded: false }, ...current];
          case 2:
            return current.filter((item) => item.id !== '0');
          case 3:
            return [...current].reverse();
          case 4:
            return [];
          default:
            return data;
        }
      });
      setStep(tick);
      if (tick === 15) setStress(false);
    }, 900);
    return () => clearInterval(timer);
  }, [stress]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      <View style={{ padding: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text>List hardening: changing data</Text>
        </View>
        <Text>{`${items.length} rows · stress ${stress ? 'running' : 'idle'} · step ${step}`}</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <RNButton
            title="Prepend"
            disabled={stress}
            onPress={() => {
              const id = String(nextId.current++);
              setItems((current) => [{ id, expanded: false }, ...current]);
            }}
          />
          <RNButton
            title="Swap first two"
            disabled={stress}
            onPress={() =>
              setItems((current) =>
                current.length < 2 ? current : [current[1]!, current[0]!, ...current.slice(2)]
              )
            }
          />
          <RNButton
            title="Toggle row 0"
            disabled={stress}
            onPress={() =>
              setItems((current) =>
                current.some((item) => item.id === '0')
                  ? current.filter((item) => item.id !== '0')
                  : [data[0]!, ...current]
              )
            }
          />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <RNButton
            title="Clear / refill"
            disabled={stress}
            onPress={() => setItems((current) => (current.length ? [] : data))}
          />
          <RNButton
            title={stress ? 'Stop stress' : 'Start mutation stress'}
            onPress={() => {
              setStep(0);
              setStress((current) => !current);
            }}
          />
          <RNButton
            title="Reset rows"
            onPress={() => {
              setStress(false);
              setStep(0);
              setItems(data);
              nextId.current = 200;
              setGeneration((value) => value + 1);
            }}
          />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: 36 }}>
          <RNButton title="Pagination example" onPress={onPagination} />
        </View>
      </View>
      <Host style={{ flex: 1 }}>
        <List
          key={generation}
          data={items}
          keyExtractor={keyExtractor}
          estimatedRowHeight={100}
          initialNumToRender={0}
          overscanCount={5}
          renderItem={renderItem}
        />
      </Host>
    </SafeAreaView>
  );
}
