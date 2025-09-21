# Power Chart Formatting Documentation

## Overview
The power chart in Fronius Pusher provides a real-time visualization of power flow across solar generation, battery storage, grid interaction, and load consumption. This document details the formatting decisions and implementation details.

## Chart Type
- **Type**: Line chart with area fill
- **Library**: Chart.js 3.x with react-chartjs-2
- **Update Frequency**: Every 2 seconds (matching data polling rate)
- **Time Window**: 10 minutes rolling window

## Data Series

### 1. Solar Generation
- **Color Scheme**: Yellow gradient (multiple shades for multiple inverters)
  - Primary: `rgba(255, 235, 59, 0.6)` border, `rgba(255, 235, 59, 0.2)` fill
  - Secondary: `rgba(255, 241, 118, 0.6)` border, `rgba(255, 241, 118, 0.2)` fill
  - Tertiary: `rgba(255, 249, 196, 0.6)` border, `rgba(255, 249, 196, 0.2)` fill
- **Stacking**: Stacked area for multiple inverters
- **Legend Order**: First (highest priority)

### 2. Battery
- **Color**: Blue
  - Border: `rgb(59, 130, 246)`
  - Fill: `rgba(59, 130, 246, 0.1)`
- **Values**: Positive for discharge, negative for charge
- **Legend Order**: Second

### 3. Grid
- **Color**: Purple
  - Border: `rgb(147, 51, 234)`
  - Fill: `rgba(147, 51, 234, 0.1)`
- **Values**: Positive for import, negative for export
- **Legend Order**: Third

### 4. Load
- **Color**: Orange
  - Border: `rgb(249, 115, 22)`
  - Fill: `rgba(249, 115, 22, 0.1)`
- **Values**: Always positive (consumption)
- **Legend Order**: Fourth (last)

## Axis Configuration

### X-Axis (Time)
- **Format**: 12-hour time without seconds (e.g., "2:30")
- **Tick Strategy**: Auto-skip enabled with max 10 ticks
- **Grid Lines**:
  - Base opacity: `rgba(107, 114, 128, 0.2)` (20% opacity)
  - Minute marks (:00 seconds): `rgba(107, 114, 128, 0.4)` (40% opacity)
  - Tolerance: ±2 seconds for minute detection (due to polling interval)

### Y-Axis (Power)
- **Units**: Kilowatts (kW)
- **Range**: 
  - Minimum: -1 kW (when battery present), 0 kW (without battery)
  - Maximum: 5 kW or auto-scaled to data
- **Label Format**: 
  - Integer values only
  - "kW" suffix on topmost label only
- **Grid Lines**:
  - Standard lines: `rgba(107, 114, 128, 0.3)` at 1px width
  - Zero line: `rgba(107, 114, 128, 0.6)` at 3px width (emphasized)

## Visual Features

### Line Styling
- **Line Width**: 2px for all series except solar (1px)
- **Tension**: 0.1 (slight curve for smoothness)
- **Point Radius**: 0 (hidden for performance)
- **Hover Point Radius**: 4px
- **Gap Handling**: `spanGaps: true` (connects across null values)

### Legend
- **Position**: Bottom
- **Font**: DM Sans, 12px
- **Color**: `rgb(156, 163, 175)` (gray-400)
- **Point Style**: Uses actual line/fill style
- **Padding**: 15px between items
- **State Preservation**: Legend visibility state persists across data updates

### Tooltip
- **Mode**: Index (shows all series at hovered time)
- **Intersect**: False (doesn't require exact point hover)
- **Time Format**: `hh:mm:ssa` (e.g., "02:30:45pm")
- **Value Format**: 3 decimal places with "kW" suffix

## Performance Optimizations

### Animation
- **Duration**: 0ms (disabled for smooth real-time updates)
- **Update Method**: Direct data update without chart recreation
- **Update Strategy**: 'none' mode to prevent animations

### Data Management
- **Time Series**: Pre-computed 2-second intervals
- **History Buffer**: 10 minutes (300 data points)
- **Update Method**: Direct dataset data replacement (preserves hidden state)

### Rendering
- **Responsive**: True
- **Maintain Aspect Ratio**: False
- **Height**: Fixed at 256px (h-64 in Tailwind)

## Implementation Details

### Time Alignment
```javascript
// Create complete time series with 2-second intervals
const timePoints: Date[] = [];
for (let time = tenMinutesAgo.getTime(); time <= latestTimestamp.getTime(); time += 2000) {
  timePoints.push(new Date(time));
}
```

### Data Mapping
```javascript
// Map events to time series with 1-second tolerance
const event = historicalData.find(e => 
  Math.abs(new Date(e.timestamp).getTime() - time.getTime()) < 1000
);
```

### Update Preservation
```javascript
// Update only data, preserving all other properties including hidden state
datasets.forEach((newDataset, index) => {
  if (chart.data.datasets[index]) {
    chart.data.datasets[index].data = newDataset.data;
  } else {
    chart.data.datasets.push(newDataset);
  }
});
```

## Color Psychology
- **Yellow (Solar)**: Energy, positivity, natural power source
- **Blue (Battery)**: Stability, storage, reliability
- **Purple (Grid)**: Connection, infrastructure, external power
- **Orange (Load)**: Activity, consumption, demand

## Accessibility Considerations
- High contrast between series colors
- Distinct colors avoiding red-green colorblind conflicts
- Clear labeling with units
- Tooltips providing exact values

## Future Enhancements
- Variable time window selection (5min, 30min, 1hr)
- Export functionality for chart data
- Dark/light theme toggle
- Cumulative energy view option
- Peak detection and annotation