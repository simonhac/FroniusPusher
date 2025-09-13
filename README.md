# Fronius Pusher

A real-time monitoring dashboard for Fronius solar inverters on your local network.

![Next.js](https://img.shields.io/badge/Next.js-15.5.3-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- 🔍 **Automatic Discovery** - Automatically discovers Fronius inverters on your local network using ARP scanning
- 📊 **Real-time Monitoring** - Live updates every 2 seconds via Server-Sent Events (SSE)
- 📈 **Power Flow Visualization** - 10-minute historical chart showing solar, battery, load, and grid power
- 🎨 **Modern UI** - Dark theme with responsive design using Tailwind CSS
- 🔋 **Battery Status** - Real-time battery charge level and charging/discharging status
- 🌐 **Multi-Inverter Support** - Monitor multiple inverters with automatic master/slave detection

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
3. **Master/Slave Detection**: Inverters are classified based on their monitoring capabilities (master monitors load)
4. **Real-time Updates**: Data is fetched every 2 seconds and pushed to the client via SSE
5. **Historical Data**: The server maintains a 10-minute rolling buffer of power data for charting

## API Endpoints

- `GET /api/status` - Get current device status
- `POST /api/do` - Perform actions (e.g., `{"action": "scan"}` to trigger network scan)
- `GET /api/history` - Get historical power data
- `GET /api/sse` - Server-sent events stream for real-time updates

## Technology Stack

- **Frontend**: Next.js 15.5, React, TypeScript, Tailwind CSS
- **Charts**: Chart.js with react-chartjs-2
- **Backend**: Next.js API routes, Node.js
- **Real-time**: Server-Sent Events (SSE)
- **Styling**: Tailwind CSS, DM Sans font

## Browser Support

- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)

## Troubleshooting

### No inverters found
- Ensure your computer is on the same network as the inverters
- Check that the Solar API is enabled on your inverter
- Try manually accessing `http://<inverter-ip>/solar_api/GetAPIVersion.cgi`

### Connection issues
- Verify firewall settings allow access to inverter IPs
- Check that port 8080 is not blocked
- Ensure Node.js has network permissions

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
- Chart.js contributors for the visualization library