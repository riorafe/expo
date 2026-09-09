# SwiftUI List: synchronous-event experiment

## Direction

Extend the existing `ios/ListView.swift` with windowed React content, using the
app's existing React tree and runtime. No extra renderer, runtime, row surface,
native template, or hydration/adoption mechanism. The original children-based
`<List>{children}</List>` API still works as before.

## API

```tsx
// Keep callbacks stable; use useCallback when they depend on component values.
const keyExtractor = (message: Message) => message.id;
const renderItem = ({ item }: { item: Message }) => (
  <MessageRow message={item} />
);

<List
  data={messages}
  keyExtractor={keyExtractor}
  renderItem={renderItem}
  estimatedRowHeight={100}
  initialNumToRender={10}
  overscanCount={10}
  extraData={selectedMessageId}
/>;
```

This is still experimental. Props for the data path:

- `data`: immutable item array. Use stable unique string keys.
- `renderItem({ item, index })`: normal React content.
- `estimatedRowHeight` (64): fallback content height, excluding native row insets.
  Actual content uses SwiftUI layout, not a forced estimate.
- `initialNumToRender` (10): render and keep the first N current items mounted
  for quick returns to the top. Set 0 to allow every row to be evicted.
- `overscanCount` (10): retain/prefetch this many items on each side of appearing
  rows. It is measured in rows, unlike RN's screen-length-based `windowSize`.
- `extraData`: an immutable invalidation marker forwarded to memoized row wrappers.
  It does not rebuild the key lookup. Your renderer must still read current values;
  this prop cannot repair a stale closure.

The initial-batch and external-data marker semantics take reference from
[React Native VirtualizedList](https://reactnative.dev/docs/virtualizedlist).
Selection, sections, and editing remain on the original children API for now.
Pagination, imperative scrolling, and precise viewability callbacks are not implemented.

## Step 1: the event bridge

`EventDispatcher.experimentalRequestSynchronous(payload)` forwards a SwiftUI view
event through its Objective-C view to `ExpoViewEventEmitter`. The emitter enqueues a
discrete event inside RN's `experimental_flushSync`, requesting a synchronous beat.

The Swift call does not wait for React completion. When RN services the beat, it
coordinates access to the existing JS runtime and can execute urgent work on UI.
Waiting for busy JS and rendering can stall UI. Other queued events can be processed
too; this is not an isolated lane for one row. `onEventSent` observes dispatch, not
completion. There is no SwiftUI presentation barrier or zero-blank guarantee here.

Ordinary events remain asynchronous. Hosted SwiftUI views and both development and
production virtual views are wired through `SwiftUIViewDefinition.swift` and
`SwiftUIViewProps.swift`, with weak references to the native view.

## Step 2: keyed React content

Read `src/swift-ui/List/index.tsx`:

1. `List` selects the data or original children path. It does not stringify keys
   or reset the list when data changes.
2. `DataList` builds native keys and a key-to-item/index map in one memoized pass,
   only when `data` or `keyExtractor` changes.
3. React enumerates only mounted keys. `MemoizedListItem` skips unchanged item,
   index, renderer, and extraData props; React state/context still update normally.
4. Each rendered item is wrapped in `ListItemNativeView(rowKey)`. This is just a
   key carrier in the same React tree.
5. Native `ListView.mountedContent` matches those sparse children to keys via
   Expo UI's existing wrapper protocol. SwiftUI `ForEach` owns display order, so
   React children can remain in request order.

When data or buffer settings change, `DataList` conditionally adjusts its own state
before committing. Surviving active keys keep identity; deleted keys are removed.
There is no effect-delayed cleanup or full-list remount. Unchanged item objects and
stable callbacks let memoization skip work; changed callbacks are always respected.

## Step 3: buffered window and eviction

Read `ListRenderWindow` at the bottom of `ios/ListView.swift`:

1. A native row's `onAppear` adds its key to the appeared set. If content is missing,
   send an urgent `onRequestItem({ key, keys, revision })`, including the current
   appeared-key snapshot. JS retains already-mounted content inside its buffered
   window and mounts missing active content without a transition. It does not
   synchronously mount missing buffer rows. Trimming old content here also prevents
   growth across a long fling if background window work is starved.
2. `onDisappear` removes the key from the appeared set. It does not directly remove
   React children.
3. Native coalesces appearance/disappearance changes into an ordinary
   `onRenderWindowChange({ keys, revision })` event on the next main-queue turn.
4. JS handles that event in `startTransition`. `renderWindowKeys` forms the union of
   active rows' neighboring ranges plus the pinned initial batch. React mounts
   missing buffered content and unmounts content outside that set.
5. Distant active keys produce separate small ranges, not one huge min-to-max range.
   This avoids filling the entire gap during a rapid jump.

### Why revisions matter

Every native urgent/window event gets a monotonically increasing revision. Suppose
a transition wants to evict row A at revision 5, then row A appears and sends an
urgent request at revision 6. React may apply the urgent update before finishing the
older transition. The state updater checks the revision when applied/rebased, so
revision 5 cannot undo revision 6. Even an already-mounted urgent row advances the
revision. A later window snapshot can evict it normally once it is no longer needed.

Native also requests missing content if an appeared row loses its React child after
a delayed commit. Revisions protect JS ordering; this recovery handles the separate
native commit/lifecycle timing boundary. Neither eliminates all possible blank frames.

Events also carry the existing `dataVersion` prop. Revision answers "is this event
newer?"; dataVersion answers "does it describe the dataset React is using now?" Both
checks run inside the state updater, including transition rebases. An old dataset's
event must not evict surviving rows or resurrect a removed-and-reinserted key. Ignoring
it does not advance the accepted revision. When native receives the new data version,
`updateKeys` prunes removed keys and schedules a fresh window snapshot.

For example, window revision 10 schedules an asynchronous eviction of row A. Before
that transition finishes, urgent revision 11 requests A again. Without the revision
guard, applying the older eviction afterward would remove A's newly needed content.

Separately, suppose React has accepted revision 40 for data version 7. Native emits
revision 41 for version 7, but React replaces the dataset with version 8 before the
event is applied. Revision 41 is newer, so the ordering guard alone would accept it.
The dataVersion guard rejects it because its visibility snapshot describes old data,
even if some of its keys also exist in version 8. Native's subsequent version-8
snapshot is accepted normally. These are scalar checks, not dataset hashes/scans.

### Height retention

The actual content reports its measured height through `onGeometryChange`. Native
stores the last positive height by row key together with the list width. When React
evicts that row, its placeholder uses that measurement instead of collapsing.

A changed list width makes old measurements inapplicable until remeasured. The width
is included in the measurement callback value so mounted content refreshes its cache
even if its height stays the same. Deleted keys' measurements are pruned when the JS
data version changes, not by scanning all keys during each scroll update.

These are last-known sizes, not promises: hidden content/data or typography changes
can make a cached height stale until remount/layout. Scroll anchoring under such
changes and RNHostView measurement still need dedicated validation.

## State and performance limits

- Row-local React state is lost on eviction. Persist important item state in the
  data or an external store. Initial pinned rows are the deliberate exception.
- SwiftUI appearance is not pixel-accurate viewability. The buffer is relative to
  lifecycle-active rows, which may include SwiftUI's own preparation region.
- React content is limited to the reported active set, buffer, and initial batch
  by both urgent and background updates. Native commit lag still exists, and the
  lifecycle-active set is controlled by SwiftUI rather than a fixed numeric cap.
- Dataset indexing is O(N) on input changes. Demand work uses mounted/active keys,
  not all data. Neighbor calculation visits at most activeCount × (2 × overscan + 1)
  positions, plus the initial batch, and deduplicates keys. It is not O(1) overall.
- Native row keys and last-known height metadata can still consume O(N) memory;
  bounded React/native content is not constant total metadata storage.
- The urgent path can stall UI. Fast flings and JS stalls still require release
  profiling; this is not yet a shipping-quality or zero-blank claim.

## Verification

JS tests cover keyed identity, structural edits, memoization, 10,000-item demand
operation counts, buffered eviction/state loss, pinned initial rows, empty windows,
disjoint windows, changing buffer props, extraData, and transition/urgent ordering.

Playground uses 200 variable-height rows with `initialNumToRender={0}` and
`overscanCount={5}`. The console logs mount/unmount counts. Tap a row, scroll far
away, and return: the local tap counter should reset after eviction. The focused
Maestro flow is `apps/bare-expo/e2e/swiftui-list-step2.yaml` (updated for step 3).
Settled screenshots and functional tests are not frame-time or no-blank benchmarks.

The hardening demo also supports prepend, swapping the first two rows, deleting and
reinserting key `0`, and clearing/refilling without changing the List's React key.
Only "Reset rows" remounts the list intentionally. "Start mutation stress" runs
15 updates 900 ms apart (prepend, delete, reverse, clear, refill, repeated three times)
independently of gestures. Its timer is cleaned up on stop/unmount. The companion
`apps/bare-expo/e2e/swiftui-list-mutations.yaml` checks surviving local state, reset
state after removal, and recovery after the mutation/fling sequence. It does not
assert exact scroll anchoring or inspect every presented frame.

Rows also embed expandable RN text in `RNHostView matchContents`. The RN container
has `maxWidth: 280` but no fixed height: matchContents derives both dimensions from
RN, so wrapping requires an explicit width constraint. An unconstrained long line
is not evidence of a List measurement failure. The demo's separate SwiftUI Button
uses `buttonStyle('borderless')` to avoid a row-wide automatic button action.
`apps/bare-expo/e2e/swiftui-list-layout.yaml` checks expand/collapse, independent
presses, and remount after eviction. Expansion now belongs to the item data, while the
tap counter remains local. A tap immutably updates one item and copies the array;
scroll/window updates do not copy the dataset. Reset and clear/refill restore the
initial collapsed data. Ordinary eviction does not collapse a row anymore.

### Separating state loss from scroll anchoring

The earlier example kept expansion in row-local state. Eviction reset it, so an
expanded cached placeholder was replaced by genuinely shorter collapsed content.
Persisting expansion in the item removes that avoidable content change; forcing
the new content to keep the old height or compensating offsets would hide its cause.

With item-owned expansion, the full simulator layout flow passes without the
previous corrective swipe. Row 0's local tap count resets, proving a remount, but
its details remain expanded and interactive. Temporary geometry probes observed
approximately 406.33 points before eviction and on remount; deliberate collapse
measured approximately 150 points. The probes were removed after the check to keep
the demo small and avoid per-scroll diagnostics. A JS regression also verifies
item-owned expansion survives while row-local state resets (19 List tests pass).

This validates this same-content return scenario, not pixel-exact anchoring for
every frame, offscreen data changes, prepend/delete, or asynchronous content sizes.
No native height-cache or scroll-offset compensation change was justified by this
reproduction. Those other cases still need their own measurements and regressions.

### Known failure: prepending while scrolled down

The focused prepend reproduction **fails** on iPhone 17 Pro Max / iOS 26.5 in Debug.
It scrolls to row 10, increments its local tap counter, captures its global y, and
prepends five items with varying text lengths and alternating expanded RN content.
There are no corrective gestures between the before/after checks. The expected
result is the same tapped row still visible within 1 point of its original y.

Observed: row 10 starts at approximately y = 298.83 points. After insertion, row 5
occupies that screen position and row 10 is outside the viewport. Repeating with
`initialNumToRender={items.length}` (all React rows pinned) produces the same jump,
with row 10 initially at approximately y = 298.50 points. Eviction is therefore not
required to reproduce it. This comparison still uses Expo's data List path, not a
standalone pure-SwiftUI control; it does not isolate every possible native cause.
In the eager comparison, scrolling back to row 10 finds its counter still at 1:
the row moved out of view without losing its React state.

The Playground's "Track row 10" enables a geometry probe on that row only. It is
off by default, and "Reset rows" disables it. Its displayed y is the **last reported**
coordinate, not proof of current visibility: SwiftUI can stop reporting geometry
once the row goes offscreen even though React retains it. The reproduction checks
visibility/state as well as the coordinate, so a stale y cannot falsely pass it.
The diagnostic header has a fixed height and does not move the List when enabled.

Run `apps/bare-expo/e2e/_nested-flows/swiftui-list-prepend-repro.yaml` explicitly
with Maestro after opening Playground. It intentionally asserts the desired
behavior and currently fails; `_nested-flows` keeps this investigation out of the
automatically discovered passing suite. Before/after screenshots go to
`/tmp/swiftui-list-prepend-before.png` and `/tmp/swiftui-list-prepend-after.png`.
For the eager comparison, temporarily set `initialNumToRender={items.length}` and
reload; normal demo settings remain zero pinned rows and five-row overscan.

Do not promise prepend/chat-history position preservation yet. A follow-up needs
to preserve a surviving visible **key and its offset**, rather than an index or
an estimated sum of inserted heights. It must also handle subsequent measurements
and insertions during a fling. No native offset compensation has been added in this
step, and the passing 19 JS tests cannot establish this native layout behavior.

### Pure SwiftUI anchoring control (September 9, 2026)

`apps/bare-expo/ios/ListAnchorProbe.swift` isolates the container behavior from Expo:
200 native SwiftUI rows, stable integer IDs, variable-height text, and native
`@State` insertions. There are no React rows, placeholders, demand events, or UIKit
scroll-view inspection. `SceneDelegate` opens it only in Debug, on iOS 17+, when
launched with `--swiftui-list-anchor-probe`. Normal launches are unchanged.

The completed diagnostic on iPhone 17 Pro Max / iOS 26.5 (Debug, Xcode 27 beta)
uses "Go to 10", then a short real drag, waits for scrolling to settle, and inserts
five rows. It resets and repeats independently for append. Row 10 starts at
y = 486 points. Screenshots and accessibility visibility are checked in addition
to its last geometry value.

| Native strategy                                                 | Prepend                                         | Append                   |
| --------------------------------------------------------------- | ----------------------------------------------- | ------------------------ |
| Plain `List`                                                    | Row 10 leaves the viewport                      | Row 10 stays at y = 486  |
| `List` + `scrollTargetLayout` + `scrollPosition(id:)`           | Row 10 leaves the viewport; binding stays `nil` | Row 10 stays at y = 486  |
| `List` + explicit `ScrollViewReader.scrollTo(10, anchor: .top)` | Row 10 returns at y = 246.33                    | Also moves to y = 246.33 |
| `ScrollView` + `LazyVStack` + `scrollPosition(id:)`             | Row 10 stays at y = 486; binding tracks row 9   | Row 10 stays at y = 486  |

The Reader case deliberately restores the known test row after **every** insertion.
Its append movement is caused by that policy, not by append itself. It demonstrates
ID navigation, not a production implementation of offset preservation. It does not
automatically choose the first visible row or test custom fractional anchors.

An earlier run used only the programmatic jump, without the real drag. The stack's
binding stayed `nil` and prepend did not preserve row 10. Do not generalize the
successful gesture-driven result to initial positioning or all update paths.

Geometry callbacks can stop when a row goes offscreen: plain List reported the
same cached y even though row 10 was gone. The probe therefore labels it `lastY`,
not "visible position". A zero delta alone is **not** evidence of preservation.

To reproduce, build/install Debug on the dedicated simulator, then run from the
repository root:

```sh
xcrun simctl launch --terminate-running-process 7FFA7979-55F7-4C05-8690-FE27277B63CC dev.expo.Payments --swiftui-list-anchor-probe
maestro --device 7FFA7979-55F7-4C05-8690-FE27277B63CC test apps/bare-expo/e2e/_nested-flows/swiftui-native-anchor-matrix.yaml
```

Alternatively, enable the same launch argument in Xcode's Debug scheme. Disable
it to return to the React app. The nested Maestro flow **collects results**, rather
than asserting that all four strategies preserve position. See its console messages
in Maestro's command JSON and `/tmp/swiftui-native-<mode>-<operation>.png` screenshots.

Conclusion: the prepend failure is reproducible without the React integration.
The successful stack is a control, not a replacement for Expo UI's `List`. These
checks cover settled scrolling on one OS/device, not active flings, asynchronously
resizing rows, keyboard changes, or frame-by-frame flicker. No public anchoring prop
has been added. The unfinished UIKit compensation spike was removed; production
`ListView.swift` is unchanged from the committed implementation.

### Fractional-anchor experiment (September 10, 2026)

The Debug-only native probe now has a **Fraction** mode. It captures row 10 and
the List viewport in the same global coordinate space before inserting data, then
calls `ScrollViewReader.scrollTo` once from `onChange(of: items.count)` with a
calculated `UnitPoint`. The measured row is fully visible and shorter than the
viewport. Row insets and vertical scroll-content margins are zero in this mode
to avoid ambiguity between the measured content and its scroll target.

The calculation aligns the same fractional point in both rectangles:

```swift
let a = (rowTop - viewportTop) / (viewportHeight - rowHeight)
proxy.scrollTo(10, anchor: UnitPoint(x: 0.5, y: a))
```

This follows from `viewportTop + a * viewportHeight = rowTop + a * rowHeight`.
There are no UIKit scroll lookups, animation wrappers, retry loops, or delayed
corrections. As in the earlier Reader control, restoration also runs after append
to test the operation itself; that is not a proposed append policy.

On the same iPhone 17 Pro Max / iOS 26.5 Debug simulator:

| Operation / drag end | Before y | Requested anchor y | After y | Movement       |
| -------------------- | -------- | ------------------ | ------- | -------------- |
| Prepend / 60%        | 486.00   | 0.436073           | 523.33  | +37.33 points  |
| Prepend / 50%        | 394.33   | 0.279110           | 523.33  | +129.00 points |
| Append / 60%         | 486.00   | 0.436073           | 523.33  | +37.33 points  |

All three flows reached the final position assertion and **failed** the one-point
tolerance. Row 10 remained visible, and screenshots confirm its movement; these
are not failures to launch, tap, or locate the row. Native geometry logs agree
with the accessibility measurement text. The viewport's top was 231.33 and its
height was 690.67; the row height was 106.67. The observed final y is the centered
position: `231.33 + (690.67 - 106.67) / 2 = 523.33`.

Inference: in this tested List configuration, these two fractional anchors behave
like center alignment. This does not establish how every custom anchor behaves
on every OS, but it rules out this implementation as our offset-preservation fix.
The native build passed; production `ListView.swift` and the JS List implementation
were not changed by this experiment.

After launching the native probe as above, run the assertion explicitly:

```sh
maestro --device 7FFA7979-55F7-4C05-8690-FE27277B63CC test -e OPERATION=Prepend -e END_Y=60% apps/bare-expo/e2e/_nested-flows/swiftui-native-fractional-anchor.yaml
```

Use `END_Y=50%` for the second position or `OPERATION=Append` for the append
control. Both drags start at 65% and last 700 ms. The flow is intentionally kept
under `_nested-flows` because it asserts desired behavior that currently fails.

### Earlier checkpoint verification

Verified at the original windowing checkpoint: 15 JS tests, package typecheck/build/lint, and the Debug
iOS simulator build pass. The updated Maestro flow passes (tap, eight flings,
return to an evicted row with reset local state, tap again, reset). With the demo's
zero pinned rows and five-row buffer, 43 distinct rows mounted during the run,
with a peak of 16 mounted at once and 9 after returning/resetting. These are
observations for this run, not a universal hard cap. No List-related SwiftUI
publishing/reentrancy warnings were found in the captured native log.

The broader bare-expo typecheck has existing errors outside this example. A future
React Native hydration proposal is separate; this implementation does not depend on it.

## Production-hardening checklist

The first hardening pass brings the JS suite to 18 passing tests. Package build,
focused JS lint/format checks, Swift syntax parsing, and the native Debug simulator
build pass on the clean main-based branch. The mutation Maestro flow passes on
iPhone 17 Pro Max / iOS 26.5: surviving state through swap/prepend, state reset after
delete/reinsert, clear/refill, and recovery after 15 timed mutations with swipes.
Its final settled viewport has no missing-content accessibility nodes and remains
interactive. This does not establish exact gesture/mutation timing or zero blank frames.
The original eviction Maestro flow also passes on this rebuild: tap, eight upward
swipes, return to the evicted row with reset local state, tap again, and reset the list.

On latest main, the package typecheck is blocked by missing `@testing-library/react`
in three unrelated web tests in the local install. The broader bare-expo typecheck
also has unrelated errors; neither reports errors in the changed List/demo files.
Swiftlint succeeds with existing configuration/selection-code warnings. Physical-device
Release profiling, scroll anchoring, and broader lifecycle validation remain pending.

Keep the architecture and public prop surface steady while validating these gates:

- [x] Reproduce and reject delayed old-dataset urgent/window events, including key
      reuse and concurrent updates. Covered by JS regression tests; this is not a native
      lifecycle or presentation guarantee.
- [ ] Physical-device Release profiling: sustained and reversing flings, realistic
      rows, intentional JS stalls, and a long scroll session. Record device/OS/RN version,
      frame-time distribution and hitches, missing-content frames, peak/steady memory,
      and urgent event frequency. Measure the actual scheduler/commit work, not just the
      Swift event-enqueue method, which returns before that work completes. Compare with
      an equivalent eager SwiftUI List using the same content. Disable per-row console
      logging during measurements. Simulator Debug results do not satisfy this gate.
- [ ] Native lifecycle/data stress: prepend, reorder, delete/reinsert, clear/refill,
      navigate away/back, background/foreground, and unmount with pending events. Assert
      surviving state and eventual content recovery, no crashes/warnings, and expected
      scroll-position behavior. JS mocked-native tests cannot establish these properties.
- [ ] Dynamic layout: delayed image sizes, expanded content, offscreen data changes,
      rotation, Dynamic Type, and RNHostView intrinsic measurement. Check anchoring as well
      as final heights; cached width/height alone is not complete invalidation.
- [ ] Interaction/accessibility: embedded Pressable, Gesture Handler/Reanimated,
      VoiceOver traversal, and TextInput keyboard/focus during scrolling and eviction.
      Decide focused-row retention behavior before claiming input-heavy lists are supported.
- [ ] Compatibility: supported iOS/tvOS and RN versions, reload/teardown of the
      experimental event bridge, and existing children-based selection/sections/editing.

Ship the data API as experimental until these results establish a supported scope.
Pagination, refresh, and scroll methods are separate API work, not substitutes for
these checks. Do not claim zero blanks or native-equivalent performance from the
current functional smoke tests.
