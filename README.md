# Fronius Pusher

A real-time monitoring dashboard for Fronius solar inverters on your local network.

![Next.js](https://img.shields.io/badge/Next.js-15.5.3-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- 🔍 **Automatic Discovery** - Automatically discovers Fronius inverters on your local network using ARP scanning
- 📊 **Real-time Monitoring** - Live updates every 2 seconds via Server-Sent Events (SSE)
- 📈 **Power Flow Visualization** - 10-minute rolling window chart showing solar, battery, load, and grid power
- ⚡ **Energy Tracking** - Dual energy accumulation tracking using hardware counters and power integration
- 📉 **Energy Counters** - Real-time display of solar generation, battery charge/discharge, grid import/export, and load consumption
- 💚 **Health Indicators** - Visual status indicators with pulse animations for active data flow
- 🎨 **Modern UI** - Dark theme with responsive design using Tailwind CSS
- 🔋 **Battery Status** - Real-time battery charge level and charging/discharging status
- 🌐 **Multi-Inverter Support** - Monitor multiple inverters with site-level aggregation
- 📊 **Minutely Reporting** - Detailed energy flow table updated every minute with bidirectional power tracking
- 🏷️ **Device Management** - Automatic detection and tracking of inverters by serial number
- 📐 **Auto-scaling Charts** - Dynamic Y-axis scaling that adapts to your power generation and consumption

## Prerequisites

- Node.js 18.0 or higher
- npm or yarn
- Fronius Gen24 inverter(s) on your local network
- Network access to inverter's Solar API

## Installation

1. Clone the repository:
```bash
git clone https://github.com/simonhac/FroniusPusher.git
cd FroniusPusher
```

2. Install dependencies:
```bash
npm install
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:8080](http://localhost:8080) in your browser

## Production Deployment

Build the application for production:
```bash
npm run build
```

Start the production server:
```bash
npm start
```

## Configuration

The application runs on port 8080 by default. To change the port:

```bash
# Development
npm run dev -- --port 3000

# Production
PORT=3000 npm start
```

## How It Works

1. **Network Discovery**: The server scans your local network using ARP to find devices
2. **Inverter Detection**: Each discovered device is checked for Fronius Solar API endpoints
3. **Device Architecture**: Uses a Site singleton managing multiple Inverter instances
4. **Real-time Updates**: Data is fetched every 2 seconds and pushed to the client via SSE
5. **Historical Data**: The server maintains a 10-minute rolling buffer of power data for charting
6. **Energy Tracking**: Dual tracking system using both hardware counters and power integration with trapezoidal rule
7. **Serial Number Tracking**: Device data and energy counters are tracked by serial number for consistency across reconnections
8. **Event-Driven Updates**: Uses EventEmitter pattern for decoupled component communication
9. **Chart Optimization**: Direct data updates without re-rendering for smooth real-time visualization

## API Endpoints

- `GET /api/status` - Get current device status and site metrics
- `POST /api/do` - Perform actions (e.g., `{"action": "scan"}` to trigger network scan)
- `GET /api/sse` - Server-sent events stream for real-time updates
  - `siteUpdate` - Device connection status changes
  - `siteMetrics` - Real-time power and energy data (every 2 seconds)
  - `hiresHistory` - Historical power data for charts (10-minute window)
  - `froniusMinutely` - Minutely energy accumulation reports (last 20 reports)
  - `inverterHeartbeat` - Device health monitoring
  - `scanStatus` - Network scan progress updates

## Technology Stack

- **Frontend**: Next.js 15.5, React, TypeScript, Tailwind CSS
- **Charts**: Chart.js 3.x with react-chartjs-2 for real-time power visualization
- **Backend**: Next.js API routes, Node.js with TypeScript
- **Real-time**: Server-Sent Events (SSE) for low-latency updates
- **Styling**: Tailwind CSS, DM Sans font
- **Date Handling**: date-fns for efficient time formatting

## Browser Support

- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)

## Documentation

- [Chart Formatting Guide](docs/chart-formatting.md) - Detailed documentation on chart visualization and formatting

## Troubleshooting

### No inverters found
- Ensure your computer is on the same network as the inverters
- Check that the Solar API is enabled on your inverter
- Try manually accessing `http://<inverter-ip>/solar_api/GetAPIVersion.cgi`

### Connection issues
- Verify firewall settings allow access to inverter IPs
- Check that port 8080 is not blocked
- Ensure Node.js has network permissions

### Chart display issues
- Charts auto-scale to display all power values
- Negative values (battery charging, grid export) are shown below the zero line
- If data appears missing, check the legend - series can be toggled on/off

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is not affiliated with or endorsed by Fronius International GmbH. Fronius is a registered trademark of Fronius International GmbH.

## Author

Simon Holmes à Court

## Acknowledgments

- Fronius for their Solar API documentation
- The Next.js team for an excellent framework
- Chart.js contributors for the visualisation library