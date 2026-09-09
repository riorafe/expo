import { Button, Host, List, Text as SwiftUIText, VStack } from '@expo/ui/swift-ui';
import { useEffect, useRef, useState } from 'react';
import { Button as RNButton, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const data = Array.from({ length: 200 }, (_, index) => ({ id: String(index) }));
const keyExtractor = (item: { id: string }) => item.id;
const renderItem = ({ item }: { item: { id: string } }) => <Row id={item.id} />;
let mountedCount = 0;

function Row({ id }: { id: string }) {
  const [taps, setTaps] = useState(0);
  useEffect(() => {
    mountedCount++;
    console.info(`[List window] mount ${id}; count=${mountedCount}`);
    return () => {
      mountedCount--;
      console.info(`[List window] unmount ${id}; count=${mountedCount}`);
    };
  }, [id]);
  return (
    <VStack alignment="leading" spacing={8}>
      <Button label={`Row ${id} · taps ${taps}`} onPress={() => setTaps((value) => value + 1)} />
      <SwiftUIText>{'Variable height content. '.repeat(((Number(id) % 5) + 1) * 3)}</SwiftUIText>
    </VStack>
  );
}

export default function Playground() {
  const [generation, setGeneration] = useState(0);
  const [items, setItems] = useState(data);
  const [stress, setStress] = useState(false);
  const [step, setStep] = useState(0);
  const nextId = useRef(200);

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
            return [{ id }, ...current];
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
        <Text>List hardening: changing data</Text>
        <Text>{`${items.length} rows · stress ${stress ? 'running' : 'idle'} · step ${step}`}</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <RNButton
            title="Prepend"
            disabled={stress}
            onPress={() => {
              const id = String(nextId.current++);
              setItems((current) => [{ id }, ...current]);
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
