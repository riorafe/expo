// Temporary, Debug-only SwiftUI baseline. No React rows or UIKit scroll inspection.
#if DEBUG
import SwiftUI

@available(iOS 17.0, *)
struct ListAnchorProbe: View {
  fileprivate enum Mode: String, CaseIterable {
    case plain = "Plain List"
    case binding = "List ID"
    case reader = "List Reader"
    case fraction = "Fraction"
    case stack = "Stack ID"
  }

  @State private var mode = Mode.plain

  var body: some View {
    VStack(spacing: 8) {
      Text("Native anchoring probe").font(.headline)
      Picker("Strategy", selection: $mode) {
        ForEach(Mode.allCases, id: \.self) { mode in
          Text(mode.rawValue).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      ListAnchorSample(mode: mode).id(mode)
    }
    .padding(.top, 8)
  }
}

@available(iOS 17.0, *)
private struct ListAnchorSample: View {
  let mode: ListAnchorProbe.Mode
  @State private var items = Array(0..<200)
  @State private var position: Int?
  @State private var rowFrame = CGRect.zero
  @State private var viewportFrame = CGRect.zero
  @State private var savedAnchor: UnitPoint?
  @State private var before: CGFloat?
  @State private var operation = "Ready"

  private var measurement: String {
    let delta = before.map { String(format: "%.2f", rowFrame.minY - $0) } ?? "n/a"
    // Offscreen lazy rows may stop emitting geometry. The test must separately check
    // actual visibility; an unchanged cached coordinate alone is not a passing result.
    return "lastY=\(String(format: "%.2f", rowFrame.minY)) delta=\(delta)"
  }

  var body: some View {
    ScrollViewReader { proxy in
      VStack(spacing: 8) {
        Text("\(operation) · \(items.count) rows · bound=\(position.map(String.init) ?? "nil")")
          .font(.caption.monospacedDigit())
          .accessibilityIdentifier("probe-status")
        Text(measurement)
          .font(.caption.monospacedDigit())
          .accessibilityIdentifier("probe-measurement")
        HStack {
          Button("Go to 10") { proxy.scrollTo(10, anchor: .center) }
          Button("Prepend 5") { insert(atEnd: false) }
          Button("Append 5") { insert(atEnd: true) }
          Button("Reset") {
            items = Array(0..<200)
            position = nil
            before = nil
            savedAnchor = nil
            operation = "Ready"
            proxy.scrollTo(0, anchor: .top)
          }
        }
        .buttonStyle(.bordered)
        .font(.caption)

        container
          .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
            if mode == .fraction { viewportFrame = frame }
          }
          .onChange(of: items.count) {
            // Deliberately demonstrates ID restoration, not pixel-offset restoration.
            // Row 10 is the known anchor selected by "Go to 10" in this experiment.
            if mode == .reader, before != nil {
              proxy.scrollTo(10, anchor: .top)
            } else if mode == .fraction, let savedAnchor {
              proxy.scrollTo(10, anchor: savedAnchor)
            }
          }
      }
    }
  }

  @ViewBuilder
  private var container: some View {
    switch mode {
    case .plain, .reader:
      List { rows }.listStyle(.plain)
    case .fraction:
      // Match the measured row's bounds to its scroll target: no implicit row insets.
      List { rows.listRowInsets(EdgeInsets()) }
        .listStyle(.plain)
        .contentMargins(.vertical, 0, for: .scrollContent)
    case .binding:
      List { rows.scrollTargetLayout() }
        .listStyle(.plain)
        .scrollPosition(id: $position)
    case .stack:
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          rows
        }
        .scrollTargetLayout()
      }
      .scrollPosition(id: $position)
    }
  }

  private var rows: some View {
    ForEach(items, id: \.self) { id in
      VStack(alignment: .leading, spacing: 8) {
        Text("Native row \(id)").font(.headline)
        Text(String(repeating: "Variable height content. ", count: (abs(id) % 5 + 1) * 3))
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(id == 10 ? Color.yellow.opacity(0.4) : Color.blue.opacity(0.06))
      .id(id)
      .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
        if id == 10 {
          rowFrame = frame
          if mode == .fraction, let before {
            NSLog("%@", "[Fraction anchor] after y=\(frame.minY) delta=\(frame.minY - before)")
          }
        }
      }
    }
  }

  private func insert(atEnd: Bool) {
    if mode == .fraction {
      guard rowFrame.height > 0, viewportFrame.height > rowFrame.height,
        rowFrame.minY >= viewportFrame.minY, rowFrame.maxY <= viewportFrame.maxY else {
        operation = "Show row 10 first"
        return
      }
      // Align the same fractional point in the row and viewport:
      // viewportTop + a * viewportHeight = rowTop + a * rowHeight.
      let fraction = (rowFrame.minY - viewportFrame.minY) / (viewportFrame.height - rowFrame.height)
      savedAnchor = UnitPoint(x: 0.5, y: fraction)
      NSLog("%@", "[Fraction anchor] \(atEnd ? "append" : "prepend") before=\(rowFrame) viewport=\(viewportFrame) a=\(fraction)")
    }
    before = rowFrame.minY
    operation = atEnd ? "Append" : "Prepend"
    // IDs and content of existing rows never change. No animation or corrective delay.
    if atEnd {
      let start = (items.last ?? 0) + 1
      items.append(contentsOf: start..<(start + 5))
    } else {
      let end = items.first ?? 0
      items.insert(contentsOf: (end - 5)..<end, at: 0)
    }
  }
}
#endif
