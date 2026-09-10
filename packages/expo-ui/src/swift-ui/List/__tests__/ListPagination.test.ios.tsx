import { act, fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import { List } from '..';

jest.mock('expo', () => ({
  requireNativeView: () => require('react-native').View,
}));

const data = [{ id: 'a' }, { id: 'b' }];
const props = {
  data,
  keyExtractor: (item: { id: string }) => item.id,
  renderItem: ({ item }: { item: { id: string } }) => <Text>{item.id}</Text>,
  testID: 'list',
  initialNumToRender: 0,
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const flush = () => act(() => jest.runOnlyPendingTimers());

it('uses remaining item count, not overscan, and rearms after append', () => {
  const onEndReached = jest.fn();
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  const screen = render(
    <List {...props} data={items} onEndReached={onEndReached} onEndReachedItemThreshold={2} />
  );
  const appear = (keys: string[], revision: number, dataVersion = 0) =>
    fireEvent(screen.getByTestId('list'), 'renderWindowChange', {
      nativeEvent: { keys, revision, dataVersion },
    });
  appear(['b'], 1); // Three remaining; overscan includes the tail but doesn't count.
  flush();
  expect(onEndReached).not.toHaveBeenCalled();
  appear(['c'], 2); // Exactly two remaining.
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  appear(['e'], 3);
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  screen.rerender(
    <List
      {...props}
      data={[...items, { id: 'f' }, { id: 'g' }]}
      onEndReached={onEndReached}
      onEndReachedItemThreshold={2}
    />
  );
  flush(); // Existing appeared e is already within the new tail's threshold.
  expect(onEndReached).toHaveBeenCalledTimes(2);
});

it('handles threshold changes and cancels pending work when leaving the range', () => {
  const onEndReached = jest.fn();
  const screen = render(<List {...props} onEndReached={onEndReached} />);
  fireEvent(screen.getByTestId('list'), 'renderWindowChange', {
    nativeEvent: { keys: ['a'], revision: 1, dataVersion: 0 },
  });
  flush();
  expect(onEndReached).not.toHaveBeenCalled();
  screen.rerender(<List {...props} onEndReached={onEndReached} onEndReachedItemThreshold={100} />);
  screen.rerender(<List {...props} onEndReached={onEndReached} onEndReachedItemThreshold={0} />);
  flush();
  expect(onEndReached).not.toHaveBeenCalled();
  screen.rerender(<List {...props} onEndReached={onEndReached} onEndReachedItemThreshold={1} />);
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  screen.rerender(<List {...props} onEndReached={onEndReached} onEndReachedItemThreshold={100} />);
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
});

it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid item threshold %s',
  (threshold) => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<List {...props} onEndReachedItemThreshold={threshold} />)).toThrow(
        'List onEndReachedItemThreshold must be a non-negative safe integer.'
      );
    } finally {
      error.mockRestore();
    }
  }
);

it('defers pagination out of urgent demand and deduplicates reappearance and rerenders', () => {
  const onEndReached = jest.fn();
  const screen = render(<List {...props} onEndReached={onEndReached} />);
  flush();
  expect(onEndReached).not.toHaveBeenCalled();
  fireEvent(screen.getByTestId('list'), 'requestItem', {
    nativeEvent: { key: 'b', keys: ['b'], revision: 1, dataVersion: 0 },
  });
  expect(onEndReached).not.toHaveBeenCalled();
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  for (const [revision, keys] of [
    [2, []],
    [3, ['b']],
  ] as const) {
    fireEvent(screen.getByTestId('list'), 'renderWindowChange', {
      nativeEvent: { keys, revision, dataVersion: 0 },
    });
    flush();
  }
  const replacement = jest.fn();
  screen.rerender(<List {...props} data={[...data]} onEndReached={replacement} />);
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
});

it('rearms for an appended last key, ignores stale events, and does not count overscan', () => {
  const onEndReached = jest.fn();
  const screen = render(<List {...props} onEndReached={onEndReached} overscanCount={10} />);
  const window = (keys: string[], revision: number, dataVersion: number) =>
    fireEvent(screen.getByTestId('list'), 'renderWindowChange', {
      nativeEvent: { keys, revision, dataVersion },
    });
  window(['a'], 1, 0);
  flush();
  expect(screen.getByText('b')).toBeTruthy(); // Prefetched React content is not appearance.
  expect(onEndReached).not.toHaveBeenCalled();
  window(['b'], 2, 0);
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  screen.rerender(<List {...props} data={[...data, { id: 'c' }]} onEndReached={onEndReached} />);
  flush();
  window(['c'], 3, 0); // Previous dataset cannot trigger the next page.
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  window(['c'], 4, 1);
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(2);
});

it('cancels pending notification when data changes or the list unmounts', () => {
  const onEndReached = jest.fn();
  const screen = render(<List {...props} onEndReached={onEndReached} />);
  fireEvent(screen.getByTestId('list'), 'renderWindowChange', {
    nativeEvent: { keys: ['b'], revision: 1, dataVersion: 0 },
  });
  screen.rerender(<List {...props} data={[...data, { id: 'c' }]} onEndReached={onEndReached} />);
  flush();
  expect(onEndReached).not.toHaveBeenCalled();
  fireEvent(screen.getByTestId('list'), 'renderWindowChange', {
    nativeEvent: { keys: ['c'], revision: 2, dataVersion: 1 },
  });
  screen.unmount();
  flush();
  expect(onEndReached).not.toHaveBeenCalled();
});

it('supports late callback subscription and resets after committed empty data', () => {
  const onEndReached = jest.fn();
  const screen = render(<List {...props} />);
  fireEvent(screen.getByTestId('list'), 'renderWindowChange', {
    nativeEvent: { keys: ['b'], revision: 1, dataVersion: 0 },
  });
  screen.rerender(<List {...props} onEndReached={onEndReached} />);
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  screen.rerender(<List {...props} data={[]} onEndReached={onEndReached} />);
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(1);
  screen.rerender(<List {...props} onEndReached={onEndReached} />);
  fireEvent(screen.getByTestId('list'), 'renderWindowChange', {
    nativeEvent: { keys: ['b'], revision: 2, dataVersion: 2 },
  });
  flush();
  expect(onEndReached).toHaveBeenCalledTimes(2);
});
