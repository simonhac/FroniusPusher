'use client';

import { useState, useEffect, useRef } from 'react';
import { formatDistance } from 'date-fns';
import dynamic from 'next/dynamic';
import { 
  Home as HomeIcon, 
  Search, 
  ExternalLink,
  Star,
  Circle
} from 'lucide-react';
import { FroniusMinutely } from '@/types/fronius';
import { DeviceInfo } from '@/types/device';
import FroniusMinutelyDisplay from '@/components/FroniusMinutelyDisplay';
import PowerCard from '@/components/PowerCard';
import HealthIndicator from '@/components/HealthIndicator';

const PowerChart = dynamic(() => import('@/components/PowerChart'), { 
  ssr: false,
  loading: () => <div className="h-64 flex items-center justify-center bg-transparent rounded-lg">
    <p className="text-gray-500">Loading chart...</p>
  </div>
});

const EnergyTable = dynamic(() => import('@/components/EnergyTable'), { 
  ssr: false 
});

interface FroniusDevice {
  ip: string;
  mac: string;
  hostname?: string;
  isMaster: boolean;
  serialNumber: string;
  info?: DeviceInfo;
  power?: {
    solarW?: number;
    batteryW?: number;
    gridW?: number;
    batterySoC?: number;
  } | null;
  lastUpdated?: string;
  lastDataFetch?: string;
  name?: string;
}

interface SiteInfo {
  name: string;
  devices: FroniusDevice[];
  power: {
    solarW: number | null;
    batteryW: number | null;
    gridW: number | null;
    loadW: number | null;
  };
  energy: {
    solarWh: number;
    batteryInWh: number;
    batteryOutWh: number;
    gridInWh: number;
    gridOutWh: number;
    loadWh: number;
  };
  batterySOC: number | null;
  hasFault: boolean;
  faults: any[];
}

export default function Home() {
  const [devices, setDevices] = useState<FroniusDevice[]>([]);
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
  const [froniusMinutelyHistory, setFroniusMinutelyHistory] = useState<FroniusMinutely[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<FroniusDevice | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [, forceUpdate] = useState({});
  const [historicalData, setHistoricalData] = useState<any[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [latestSiteMetrics, setLatestSiteMetrics] = useState<any>(null);

  // Initialise SSE connection
  useEffect(() => {
    const connectSSE = () => {
      // Close any existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      
      console.log('Connecting to SSE...');
      const eventSource = new EventSource('/api/sse');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('SSE connected');
        setConnected(true);
      };

      eventSource.onerror = (error) => {
        console.log('SSE connection lost, will reconnect in 5 seconds');
        setConnected(false);
        eventSource.close();
        // Reconnect after 5 seconds
        setTimeout(() => {
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            connectSSE();
          }
        }, 5000);
      };

      // Handle high-resolution history to prepopulate the chart
      eventSource.addEventListener('hiresHistory', (event) => {
        const history = JSON.parse(event.data);
        console.log('[SSE] hiresHistory: Received', history.length, 'data points for chart prepopulation');
        
        // History is now simply an array of siteMetrics objects
        // Set it directly - this only runs once on connection
        setHistoricalData(history);
      });
      
      // Handle minutely history (FroniusMinutely reports)
      eventSource.addEventListener('minutelyHistory', (event) => {
        const history = JSON.parse(event.data);
        console.log('[SSE] minutelyHistory: Received', history.length, 'minutely reports');
        setFroniusMinutelyHistory(history);
      });
      
      // No longer needed - devices come with siteUpdate
      // eventSource.addEventListener('devices', ...) removed

      // Handle scan status updates
      eventSource.addEventListener('scanStatus', (event) => {
        const status = JSON.parse(event.data);
        console.log('[SSE] scanStatus:', status);
        
        if (status.state === 'SCANNING') {
          setIsScanning(true);
        } else if (status.state === 'IDLE') {
          setIsScanning(false);
        }
      });

      // Handle FroniusMinutely updates (once per minute)
      eventSource.addEventListener('froniusMinutely', (event) => {
        const data = JSON.parse(event.data) as FroniusMinutely;
        console.log('[SSE] froniusMinutely:', data);
        setFroniusMinutelyHistory(prev => {
          const newHistory = [data, ...prev].slice(0, 10); // Keep only last 10
          return newHistory;
        });
      });
      
      // Handle site updates
      eventSource.addEventListener('siteUpdate', (event) => {
        const site = JSON.parse(event.data);
        console.log('[SSE] siteUpdate:', site);
        setSiteInfo(site);
        
        // Extract devices from site info
        if (site.devices) {
          setDevices(site.devices);
          setLastUpdate(new Date());
          setInitialLoadComplete(true);
          
          // Energy counters are now in powerUpdate events
          
          // Update selected device if it exists in the new list
          if (selectedDevice) {
            const updated = site.devices.find((d: FroniusDevice) => d.ip === selectedDevice.ip);
            if (updated) {
              setSelectedDevice(updated);
            }
          }
        }
      });

      // Handle inverter heartbeat events (sent on each poll)
      eventSource.addEventListener('inverterHeartbeat', (event) => {
        const heartbeat = JSON.parse(event.data);
        // console.log('[SSE] inverterHeartbeat:', heartbeat.serialNumber, heartbeat.status);
        
        // Update lastDataFetch for the device
        setDevices(prevDevices => 
          prevDevices.map(device => 
            device.serialNumber === heartbeat.serialNumber
              ? { ...device, lastDataFetch: heartbeat.timestamp }
              : device
          )
        );
        
        // Dispatch a custom event that HealthIndicator components can listen to
        window.dispatchEvent(new CustomEvent('inverterHeartbeat', { 
          detail: heartbeat 
        }));
      });
      
      // Handle site metrics events (latest readings for chart)
      eventSource.addEventListener('siteMetrics', (event) => {
        const siteMetrics = JSON.parse(event.data);
        console.log('[SSE] siteMetrics:', siteMetrics);
        
        // Store latest site metrics for tiles and energy counters
        setLatestSiteMetrics(siteMetrics);
        
        // Simply accumulate site metrics events for chart
        setHistoricalData(prev => {
          const newHistory = [...prev, siteMetrics];
          // Keep only last 10 minutes of data
          const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
          return newHistory.filter(event => new Date(event.timestamp) >= tenMinutesAgo);
        });
      });
      
      // Handle LiveOne push test results
      eventSource.addEventListener('pushTest', (event) => {
        const testResult = JSON.parse(event.data);
        console.log('[SSE] pushTest:', testResult);
      });

      // Individual device data updates are no longer sent - all updates come via siteUpdate
    };

    connectSSE();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Load initial status
  useEffect(() => {
    // Load device status
    fetch('/api/status')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          if (data.devices) {
            setDevices(data.devices);
          }
          
          // Set scanning status from API
          if (data.isScanning !== undefined) {
            setIsScanning(data.isScanning);
          }
          
          if (data.site) {
            setSiteInfo(data.site);
          }
          
          setInitialLoadComplete(true);
          
          if (data.lastScan) {
            setLastUpdate(new Date(data.lastScan));
          }
          
          // Auto-select first master device or first device
          if (data.devices && data.devices.length > 0) {
            const master = data.devices.find((d: FroniusDevice) => d.isMaster);
            if (master) {
              setSelectedDevice(master);
            } else {
              setSelectedDevice(data.devices[0]);
            }
          }
        }
      })
      .catch(error => {
        console.error(error);
        setInitialLoadComplete(true);
      });
  }, []);

  // Update status dots every second
  useEffect(() => {
    const interval = setInterval(() => {
      forceUpdate({});
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const scanDevices = async () => {
    try {
      const response = await fetch('/api/do', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'scan' }),
      });
      const data = await response.json();
      if (data.success) {
        // Scan initiated - updates will come via SSE
        console.log('Scan initiated');
      }
    } catch (error) {
      console.error('Error initiating scan:', error);
      setIsScanning(false);
    }
  };

  const DeviceIcon = ({ device }: { device: FroniusDevice }) => {
    if (device.isMaster) {
      return <Star className="w-6 h-6 text-yellow-500" fill="currentColor" />;
    }
    return <Circle className="w-6 h-6 text-gray-400" />;
  };


  return (
    <div className="min-h-screen bg-black p-6">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-3xl font-bold text-white">Fronius Pusher</h1>
          </div>
          <button
            onClick={scanDevices}
            disabled={isScanning}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-600 transition flex items-center space-x-2"
          >
            {isScanning ? (
              <>
                <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Scanning...</span>
              </>
            ) : (
              <>
                <Search className="w-5 h-5" />
                <span>Scan</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Site Panel with House Icon */}
      {siteInfo && (
        <div className="bg-black rounded flex items-start mb-6">
          {/* House Icon */}
          <div className="w-40 h-40 flex items-center justify-center mr-5">
            <HomeIcon className="w-32 h-32 text-gray-400" strokeWidth={1.25} />
          </div>
          <div className="flex-1">
            <div className="flex items-center space-x-3 mt-4">
              <h3 className="text-2xl font-semibold text-white">
                {siteInfo.name}
              </h3>
              <span className="text-sm text-gray-400">Site Total</span>
              <HealthIndicator devices={devices} />
            </div>
            
            {/* Site Power Cards - Order: Solar, Battery, Grid, Load */}
            <div className="flex flex-wrap gap-3 mt-4 mb-5">
              <PowerCard
                label="Solar (Total)"
                iconName="solar"
                color="yellow"
                value={latestSiteMetrics?.site?.solar?.powerW !== null && latestSiteMetrics?.site?.solar?.powerW !== undefined ? latestSiteMetrics.site.solar.powerW / 1000 : null}
              />
              
              {latestSiteMetrics?.site?.battery?.powerW !== null && latestSiteMetrics?.site?.battery?.powerW !== undefined && latestSiteMetrics.site.battery.powerW !== 0 && (
                <PowerCard
                  label="Battery"
                  iconName="battery"
                  color="blue"
                  value={Math.abs(latestSiteMetrics.site.battery.powerW) / 1000}
                  secondaryValue={latestSiteMetrics.site.battery.soc}
                  secondaryUnit="%"
                  subtext={
                    latestSiteMetrics.site.battery.powerW < -100 ? 'Charging' : 
                    latestSiteMetrics.site.battery.powerW > 100 ? 'Discharging' : 'Idle'
                  }
                />
              )}
              
              {latestSiteMetrics?.site?.grid?.powerW !== null && latestSiteMetrics?.site?.grid?.powerW !== undefined && (
                <PowerCard
                  label="Grid"
                  iconName="grid"
                  color="purple"
                  value={Math.abs(latestSiteMetrics.site.grid.powerW) / 1000}
                  subtext={latestSiteMetrics.site.grid.powerW > 0 ? 'Importing' : latestSiteMetrics.site.grid.powerW < 0 ? 'Exporting' : 'Idle'}
                />
              )}
              
              <PowerCard
                label="Load"
                iconName="load"
                color="orange"
                value={latestSiteMetrics?.site?.load?.powerW !== null && latestSiteMetrics?.site?.load?.powerW !== undefined ? latestSiteMetrics.site.load.powerW / 1000 : null}
              />
            </div>
            
            {/* FroniusMinutely Display */}
            <FroniusMinutelyDisplay history={froniusMinutelyHistory} />
          </div>
        </div>
      )}

      {/* Inverter Panels */}
      <div>
        {!initialLoadComplete ? (
          <div className="flex items-center justify-center h-64">
            <div className="bg-transparent rounded-lg p-6 text-center">
              <p className="text-gray-500 text-lg">Loading system…</p>
            </div>
          </div>
        ) : devices.length === 0 ? (
          <div className="flex items-center justify-center h-64 bg-black rounded">
            <div className="text-center">
              {isScanning ? (
                <>
                  <svg className="w-12 h-12 mx-auto mb-2 text-gray-400 animate-spin" fill="none" 
                    stroke="currentColor" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <p className="text-gray-500 text-sm">Scanning for devices…</p>
                </>
              ) : (
                <>
                  <svg className="w-24 h-24 mx-auto mb-2 text-gray-600" fill="none" 
                    stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <p className="text-gray-500 text-sm">No devices found</p>
                </>
              )}
            </div>
          </div>
        ) : (
          devices
            .sort((a, b) => {
              // Sort master devices first
              if (a.isMaster && !b.isMaster) return -1;
              if (!a.isMaster && b.isMaster) return 1;
              return 0;
            })
            .map((device) => (
            <div
              key={device.ip}
              className="bg-black rounded flex items-start"
            >
              <img 
                src="/images/Gen24.png" 
                alt="Fronius Inverter" 
                className="w-40 h-40 object-contain mr-5"
              />
              <div className="flex-1">
                <div className="flex items-center space-x-3 mt-4">
                  <h3 className="text-2xl font-semibold text-white">
                    {device.info?.inverter?.customName || 'Fronius Inverter'}
                  </h3>
                  <div className="relative group">
                    <a
                      href={`http://${device.hostname || device.ip}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <ExternalLink className="w-5 h-5" />
                    </a>
                    {/* Tooltip */}
                    <div className="absolute invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-1000 bg-gray-800 text-white p-3 rounded-lg shadow-xl z-50 left-0 top-8 min-w-max">
                      <div className="text-sm space-y-1">
                        {device.hostname && (
                          <p>
                            Hostname:{' '}
                            <a 
                              href={`http://${device.hostname}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {device.hostname}
                            </a>
                          </p>
                        )}
                        <p>IP: {device.ip}</p>
                        <p>MAC: {device.mac}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <HealthIndicator serialNumber={device.serialNumber} />
                    {device.lastDataFetch && 
                     (new Date().getTime() - new Date(device.lastDataFetch).getTime() >= 10000) && (
                      <span className="text-xs text-gray-500">
                        Last update: {formatDistance(new Date(device.lastDataFetch), new Date(), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs">
                  <span className="text-gray-500">Serial# {device.serialNumber}</span>
                </p>
                
                {/* Power Cards */}
                {latestSiteMetrics && latestSiteMetrics[device.serialNumber] && (
                  <div className="flex flex-wrap gap-3 mt-4 mb-5">
                    {/* Solar */}
                    {latestSiteMetrics[device.serialNumber].solar?.powerW !== undefined && latestSiteMetrics[device.serialNumber].solar?.powerW !== null && (
                      <PowerCard
                        label="Solar"
                        iconName="solar"
                        color="yellow"
                        value={latestSiteMetrics[device.serialNumber].solar.powerW / 1000}
                        infoTitle="Inverter Details"
                        infoItems={device.info?.inverter ? [
                          { label: "Manufacturer", value: device.info.inverter.manufacturer },
                          { label: "Model", value: device.info.inverter.model },
                          { label: "PV Capacity", value: `${(device.info.inverter.pvPowerW / 1000).toFixed(1)} kW` },
                          { label: "Serial", value: device.info.inverter.serialNumber }
                        ] : undefined}
                      />
                    )}
                    
                    {/* Battery */}
                    {latestSiteMetrics[device.serialNumber].battery?.powerW !== undefined && latestSiteMetrics[device.serialNumber].battery?.powerW !== null && (
                      <PowerCard
                        label="Battery"
                        iconName="battery"
                        color="blue"
                        value={Math.abs(latestSiteMetrics[device.serialNumber].battery.powerW) / 1000}
                        unit="kW"
                        secondaryValue={latestSiteMetrics[device.serialNumber].battery?.soc}
                        secondaryUnit="%"
                        subtext={latestSiteMetrics[device.serialNumber].battery.powerW < -100 ? 'Charging' : 
                                 latestSiteMetrics[device.serialNumber].battery.powerW > 100 ? 'Discharging' : 'Idle'}
                        infoTitle="Battery Details"
                        infoItems={device.info?.battery ? [
                          ...(device.info.battery.manufacturer ? [{ label: "Manufacturer", value: device.info.battery.manufacturer }] : []),
                          ...(device.info.battery.model ? [{ label: "Model", value: device.info.battery.model }] : []),
                          ...(device.info.battery.capacityWh ? [{ label: "Capacity", value: `${(device.info.battery.capacityWh / 1000).toFixed(1)} kWh` }] : []),
                          ...(device.info.battery.serial ? [{ label: "Serial", value: device.info.battery.serial }] : [])
                        ] : undefined}
                      />
                    )}
                    
                    {/* Grid */}
                    {latestSiteMetrics[device.serialNumber].grid?.powerW !== undefined && latestSiteMetrics[device.serialNumber].grid?.powerW !== null && (
                      <PowerCard
                        label="Grid"
                        iconName="grid"
                        color="purple"
                        value={Math.abs(latestSiteMetrics[device.serialNumber].grid.powerW) / 1000}
                        subtext={latestSiteMetrics[device.serialNumber].grid.powerW > 0 ? 'Importing' : 'Exporting'}
                        infoTitle="Grid Meter Details"
                        infoItems={device.info?.meter ? [
                          ...(device.info.meter.manufacturer ? [{ label: "Manufacturer", value: device.info.meter.manufacturer }] : []),
                          ...(device.info.meter.model ? [{ label: "Model", value: device.info.meter.model }] : []),
                          ...(device.info.meter.location ? [{ label: "Location", value: device.info.meter.location }] : []),
                          ...(device.info.meter.serial ? [{ label: "Serial", value: device.info.meter.serial }] : []),
                          ...(device.info.meter.enabled !== undefined ? [{ label: "Status", value: device.info.meter.enabled ? 'Enabled' : 'Disabled' }] : [])
                        ] : undefined}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Power Chart - Below Inverters */}
      {devices.length > 0 && historicalData.length > 0 && (
        <div className="mb-6">
          <div className="bg-transparent rounded-lg">
            <PowerChart 
              historicalData={historicalData}
              devices={devices}
            />
          </div>
        </div>
      )}

      {/* Energy Table - Below Chart */}
      {devices.length > 0 && latestSiteMetrics && (
        <EnergyTable 
          devices={devices.map(device => ({
            ip: device.ip,
            name: device.info?.inverter?.customName || device.hostname?.split('.')[0] || device.ip,
            energyCounters: latestSiteMetrics[device.serialNumber] ? {
              solarWh: latestSiteMetrics[device.serialNumber].solar?.energyWh,
              batteryInWh: latestSiteMetrics[device.serialNumber].battery?.energyInWh,
              batteryOutWh: latestSiteMetrics[device.serialNumber].battery?.energyOutWh,
              gridInWh: latestSiteMetrics[device.serialNumber].grid?.energyInWh,
              gridOutWh: latestSiteMetrics[device.serialNumber].grid?.energyOutWh,
              loadWh: undefined // Load is only at site level
            } : {}
          }))}
          siteEnergy={latestSiteMetrics?.site ? {
            solarWh: latestSiteMetrics.site.solar?.energyWh,
            batteryInWh: latestSiteMetrics.site.battery?.energyInWh,
            batteryOutWh: latestSiteMetrics.site.battery?.energyOutWh,
            gridInWh: latestSiteMetrics.site.grid?.energyInWh,
            gridOutWh: latestSiteMetrics.site.grid?.energyOutWh,
            loadWh: latestSiteMetrics.site.load?.energyWh
          } : null}
        />
      )}

    </div>
  );
}